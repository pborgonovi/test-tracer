const axios = require('axios');

const GITHUB_API = 'https://api.github.com';

function buildClient() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is not set.');
  }

  return axios.create({
    baseURL: GITHUB_API,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

/**
 * Returns an array of { path, content } objects for every .md file
 * that was added or modified in the given pull request.
 *
 * @param {string} owner      - GitHub repository owner (user or org)
 * @param {string} repo       - Repository name
 * @param {number} prNumber   - Pull request number
 * @returns {Promise<Array<{ path: string, content: string }>>}
 */
async function getMdFilesFromPR(owner, repo, prNumber) {
  const client = buildClient();

  // Fetch the list of files changed in the PR (up to 300 files via pagination)
  const changedFiles = await fetchAllPRFiles(client, owner, repo, prNumber);

  const mdFiles = changedFiles.filter(
    (f) => f.filename.endsWith('.md') && f.status !== 'removed'
  );

  if (mdFiles.length === 0) {
    return [];
  }

  // Fetch file contents in parallel
  const results = await Promise.all(
    mdFiles.map(async (f) => {
      const content = await fetchFileContent(client, owner, repo, f.filename, f.sha);
      return { path: f.filename, content };
    })
  );

  return results;
}

/**
 * Pages through /pulls/{prNumber}/files (max 100 per page) and returns
 * the full list of changed file objects.
 */
async function fetchAllPRFiles(client, owner, repo, prNumber) {
  const files = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await client.get(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files`,
      { params: { per_page: perPage, page } }
    );

    files.push(...data);

    if (data.length < perPage) break;
    page++;
  }

  return files;
}

/**
 * Fetches raw file content using the blob SHA returned by the PR files API,
 * decoding the base64 payload that GitHub returns.
 */
async function fetchFileContent(client, owner, repo, filePath, sha) {
  const { data } = await client.get(`/repos/${owner}/${repo}/git/blobs/${sha}`);

  if (data.encoding !== 'base64') {
    throw new Error(`Unexpected encoding "${data.encoding}" for file: ${filePath}`);
  }

  return Buffer.from(data.content, 'base64').toString('utf8');
}

/**
 * Crawls linked GitHub issues up to 2 levels deep.
 *
 * - The original PR body and modified .md files are scanned as seed sources,
 *   but the PR itself is NOT included as an artifact.
 * - Only issues (not PRs) found during the crawl are fetched and returned.
 * - Depth 1: extract issue URLs from the seed sources, fetch their bodies.
 * - Depth 2: extract issue URLs from the depth-1 bodies, fetch any not yet seen.
 *
 * A single shared set ensures the same URL is never fetched twice across levels.
 *
 * @param {Array<{ path: string, content: string }>} mdFiles
 * @param {string} owner     - Owner of the original PR
 * @param {string} repo      - Repo of the original PR
 * @param {number} prNumber  - Number of the original PR
 * @returns {Promise<Array<{ url: string, type: 'issue', body: string }>>}
 */
async function getLinkedArtifacts(mdFiles, owner, repo, prNumber) {
  const client = buildClient();

  // Tracks every URL that has been queued to prevent duplicate requests.
  const fetched = new Set();

  const issuesOnly = (refs) => refs.filter((ref) => ref.type === 'issue');

  // --- Seed sources: PR description + modified .md files ---
  // The PR body is scanned for linked URLs but not returned as an artifact.
  const prBody = await fetchPRBody(client, owner, repo, prNumber);
  const initialSources = [
    { path: `PR #${prNumber} body (${owner}/${repo})`, content: prBody },
    ...mdFiles,
  ];

  // --- Depth 1: issues only ---
  const depth1Refs = issuesOnly(extractGitHubURLs(initialSources)).filter(({ url }) => {
    if (fetched.has(url)) return false;
    fetched.add(url);
    return true;
  });

  if (depth1Refs.length === 0) {
    return [];
  }

  const depth1Artifacts = (
    await Promise.all(
      depth1Refs.map(({ url, owner: o, repo: r, type, number }) =>
        tryFetchArtifactBody(client, url, o, r, type, number)
      )
    )
  ).filter(Boolean);

  // --- Depth 2: issues only, extracted from depth-1 bodies ---
  const depth1Bodies = depth1Artifacts.map((artifact) => ({
    path: artifact.url,
    content: artifact.body,
  }));

  const depth2Refs = issuesOnly(extractGitHubURLs(depth1Bodies)).filter(({ url }) => {
    if (fetched.has(url)) return false;
    fetched.add(url);
    return true;
  });

  if (depth2Refs.length === 0) {
    return depth1Artifacts;
  }

  const depth2Artifacts = (
    await Promise.all(
      depth2Refs.map(({ url, owner: o, repo: r, type, number }) =>
        tryFetchArtifactBody(client, url, o, r, type, number)
      )
    )
  ).filter(Boolean);

  return [...depth1Artifacts, ...depth2Artifacts];
}

/**
 * Fetches the body text of a pull request.
 */
async function fetchPRBody(client, owner, repo, prNumber) {
  const { data } = await client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  return data.body || '';
}

/**
 * Scans every file's content and returns a deduplicated array of parsed
 * GitHub issue/PR references found across all files.
 */
function extractGitHubURLs(mdFiles) {
  // Matches both:
  //   https://github.com/{owner}/{repo}/issues/{number}
  //   https://github.com/{owner}/{repo}/pull/{number}
  // The regex is created fresh per file to avoid stale lastIndex across iterations.
  const seen = new Map();

  for (const file of mdFiles) {
    const pattern =
      /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/g;

    for (const match of file.content.matchAll(pattern)) {
      const [url, owner, repo, segment, number] = match;
      const canonical = url.split('#')[0]; // strip any fragment anchor

      if (!seen.has(canonical)) {
        seen.set(canonical, {
          url: canonical,
          owner,
          repo,
          type: segment === 'issues' ? 'issue' : 'pr',
          number: parseInt(number, 10),
        });
      }
    }
  }

  return [...seen.values()];
}

/**
 * Wraps fetchArtifactBody with error handling. Returns null and logs a warning
 * if the fetch fails for any reason (403, 404, network error, etc.) so the
 * caller can skip the failed artifact and continue with the rest.
 */
async function tryFetchArtifactBody(client, url, owner, repo, type, number) {
  try {
    return await fetchArtifactBody(client, url, owner, repo, type, number);
  } catch (err) {
    const status = err.response ? err.response.status : null;
    const reason = status ? `HTTP ${status}` : err.message;
    console.warn(`  Warning: skipping ${url} — ${reason}`);
    return null;
  }
}

/**
 * Fetches the body of a single issue or PR using the appropriate endpoint.
 */
async function fetchArtifactBody(client, url, owner, repo, type, number) {
  const endpoint =
    type === 'issue'
      ? `/repos/${owner}/${repo}/issues/${number}`
      : `/repos/${owner}/${repo}/pulls/${number}`;

  const { data } = await client.get(endpoint);

  return {
    url,
    type,
    body: data.body || '',
  };
}

/**
 * Fetches a single GitHub issue or PR by URL and returns a { url, type, body } object.
 *
 * @param {string} artifactUrl - Full GitHub issue or PR URL
 * @returns {Promise<{ url: string, type: 'issue'|'pr', body: string }>}
 */
async function fetchArtifact(artifactUrl) {
  const pattern =
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/;
  const match = artifactUrl.match(pattern);

  if (!match) {
    throw new Error(`Invalid GitHub issue or PR URL: "${artifactUrl}"`);
  }

  const [, owner, repo, segment, number] = match;
  const type = segment === 'issues' ? 'issue' : 'pr';
  const client = buildClient();

  return fetchArtifactBody(client, artifactUrl, owner, repo, type, parseInt(number, 10));
}

module.exports = { getMdFilesFromPR, getLinkedArtifacts, fetchArtifact };
