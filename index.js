#!/usr/bin/env node

require('dotenv').config();

const { getMdFilesFromPR, getLinkedArtifacts, fetchArtifact } = require('./github');
const { extractScenarios, extractRequirements } = require('./extractor');
const { generateReport } = require('./reporter');
const { input } = require('@inquirer/prompts');

const args = process.argv.slice(2);

function parseArgs(args) {
  const result = { url: null, repo: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) {
      result.repo = args[i + 1];
      i++;
    } else if (!result.url && !args[i].startsWith('--')) {
      result.url = args[i];
    }
  }

  return result;
}

function parseGitHubPRURL(url) {
  // Matches: https://github.com/{owner}/{repo}/pull/{number}
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );

  if (!match) {
    throw new Error(
      `Could not parse GitHub PR URL: "${url}"\nExpected format: https://github.com/{owner}/{repo}/pull/{number}`
    );
  }

  return {
    owner: match[1],
    repoName: match[2],
    prNumber: parseInt(match[3], 10),
  };
}

async function main() {
  const { url, repo } = parseArgs(args);

  if (!url) {
    console.error('Usage: node index.js <github-pr-url> --repo <local-repo-path>');
    process.exit(1);
  }

  if (!repo) {
    console.error('Error: --repo flag is required. Provide a path to a local repository.');
    process.exit(1);
  }

  if (!process.env.GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN is not set. Add it to your .env file or environment.');
    process.exit(1);
  }
  console.log('GITHUB_TOKEN loaded successfully.');

  let parsed;
  try {
    parsed = parseGitHubPRURL(url);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const { owner, repoName, prNumber } = parsed;

  console.log('Parsed GitHub PR:');
  console.log(`  Owner:      ${owner}`);
  console.log(`  Repo:       ${repoName}`);
  console.log(`  PR number:  ${prNumber}`);
  console.log(`  Local repo: ${repo}`);
  console.log();

  console.log('Fetching modified .md files from PR...');
  let mdFiles;
  try {
    mdFiles = await getMdFilesFromPR(owner, repoName, prNumber);
  } catch (err) {
    console.error(`Error fetching PR files: ${err.message}`);
    process.exit(1);
  }

  if (mdFiles.length === 0) {
    console.log('No .md files were modified in this PR.');
    return;
  }

  console.log(`Found ${mdFiles.length} .md file(s):\n`);
  for (const file of mdFiles) {
    const preview = file.content.slice(0, 200).replace(/\n/g, ' ');
    const truncated = file.content.length > 200 ? '...' : '';
    console.log(`  Path:    ${file.path}`);
    console.log(`  Preview: ${preview}${truncated}`);
    console.log();
  }

  console.log('Scanning for linked GitHub issues and PRs...');
  let artifacts;
  try {
    artifacts = await getLinkedArtifacts(mdFiles, owner, repoName, prNumber);
  } catch (err) {
    console.error(`Error fetching linked artifacts: ${err.message}`);
    process.exit(1);
  }

  if (artifacts.length === 0) {
    console.log('No linked GitHub issues or PRs found in the PR body or .md files.');
    return;
  }

  console.log(`Found ${artifacts.length} linked artifact(s):\n`);
  for (const artifact of artifacts) {
    console.log(`  Type: ${artifact.type === 'pr' ? 'Pull Request' : 'Issue'}`);
    console.log(`  URL:  ${artifact.url}`);
    console.log();
  }

  // Prompt the user to optionally add extra issue URLs for more context
  console.log('You can add extra GitHub issue URLs for additional context.');
  console.log('Press Enter with an empty input when done.\n');

  const issueUrlPattern =
    /^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+/;
  const prUrlPattern =
    /^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

  while (true) {
    const extra = await input({
      message: 'Add an issue URL (or press Enter to finish):',
    });

    if (!extra.trim()) break;

    if (prUrlPattern.test(extra.trim())) {
      console.log(
        '  Only GitHub issue URLs are accepted as additional context. PR URLs are not supported.\n'
      );
      continue;
    }

    if (!issueUrlPattern.test(extra.trim())) {
      console.log(
        '  Invalid URL. Expected format: https://github.com/{owner}/{repo}/issues/{number}\n'
      );
      continue;
    }

    const canonical = extra.trim().split('#')[0];

    if (artifacts.some((a) => a.url === canonical)) {
      console.log('  Already in the list, skipping.\n');
      continue;
    }

    try {
      const artifact = await fetchArtifact(canonical);
      artifacts.push(artifact);
      console.log(`  Added: ${artifact.type === 'pr' ? 'Pull Request' : 'Issue'} — ${artifact.url}\n`);
    } catch (err) {
      console.error(`  Failed to fetch: ${err.message}\n`);
    }
  }

  console.log(`\nFinal artifact list (${artifacts.length} total):\n`);
  for (const artifact of artifacts) {
    console.log(`  Type: ${artifact.type === 'pr' ? 'Pull Request' : 'Issue'}`);
    console.log(`  URL:  ${artifact.url}`);
    console.log();
  }

  console.log('Extracting test scenarios with Gemini...');
  let scenarios;
  try {
    scenarios = await extractScenarios(mdFiles);
  } catch (err) {
    console.error(`Error extracting scenarios: ${err.message}`);
    process.exit(1);
  }

  if (scenarios.length === 0) {
    console.log('No test scenarios could be extracted from the provided content.');
  } else {
    console.log(`\nExtracted ${scenarios.length} test scenario(s):\n`);
    scenarios.forEach((scenario, i) => {
      console.log(`  ${i + 1}. ${scenario}`);
    });
  }

  console.log('\nExtracting requirements from linked artifacts with Gemini...');
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  let requirements;
  try {
    requirements = await extractRequirements(artifacts);
  } catch (err) {
    console.error(`Error extracting requirements: ${err.message}`);
    process.exit(1);
  }

  if (requirements.length === 0) {
    console.log('No requirements could be extracted from the linked artifacts.');
    return;
  }

  console.log(`\nExtracted ${requirements.length} requirement(s):\n`);
  requirements.forEach((req, i) => {
    console.log(`  ${i + 1}. ${req}`);
  });

  console.log('\nGenerating coverage report with Gemini...');
  let report;
  try {
    report = await generateReport(scenarios, requirements);
  } catch (err) {
    console.error(`Error generating report: ${err.message}`);
    process.exit(1);
  }

  const total = requirements.length;
  const coveredPct = total > 0 ? Math.round((report.covered.length / total) * 100) : 0;

  console.log('\n' + '='.repeat(60));
  console.log('  TEST COVERAGE REPORT');
  console.log('='.repeat(60));
  console.log(`  Total requirements : ${total}`);
  console.log(`  Covered            : ${report.covered.length} (${coveredPct}%)`);
  console.log(`  Missing            : ${report.missing.length}`);
  console.log(`  Unclear            : ${report.unclear.length}`);
  console.log('='.repeat(60));

  if (report.covered.length > 0) {
    console.log('\n  COVERED');
    report.covered.forEach((r, i) => console.log(`    ${i + 1}. ${r.replace(/^\d+\.\s*/, '')}`));
  }

  if (report.missing.length > 0) {
    console.log('\n  MISSING');
    report.missing.forEach((r, i) => console.log(`    ${i + 1}. ${r.replace(/^\d+\.\s*/, '')}`));
  }

  if (report.unclear.length > 0) {
    console.log('\n  UNCLEAR');
    report.unclear.forEach((r, i) => console.log(`    ${i + 1}. ${r.replace(/^\d+\.\s*/, '')}`));
  }

  console.log('\n' + '='.repeat(60));
}

main();
