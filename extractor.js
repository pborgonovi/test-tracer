const { GoogleGenAI } = require('@google/genai');

const MODEL = 'gemini-3.1-pro-preview';
const MAX_TOKENS = 8192;

/**
 * Sends the test plan markdown files to Gemini and returns a consolidated
 * list of expected test scenarios as plain-English strings.
 *
 * @param {Array<{ path: string, content: string }>} mdFiles - Modified .md files from the PR
 * @returns {Promise<string[]>} Array of test scenario strings
 */
async function extractScenarios(mdFiles) {
  const ai = buildClient();
  const prompt = buildScenariosPrompt(mdFiles);
  const result = await generateWithRetry(ai, prompt);
  return parseJsonArray(result.text, 'scenarios');
}

/**
 * Assembles the scenarios prompt from the md files.
 */
function buildScenariosPrompt(mdFiles) {
  const sections = [];

  sections.push(
    'You are a QA engineer analyzing a GitHub Pull Request that modifies test plan documentation.',
    '',
    'Your task is to extract a consolidated list of **expected test scenarios** from the materials below.',
    'Focus only on content that describes what should be tested, acceptance criteria, expected behaviors,',
    'steps to reproduce, or explicit test cases. Ignore changelogs, release notes, CI config, and',
    'anything unrelated to functional testing.',
    '',
    'Return your answer as a **JSON array of strings** — one string per scenario, written in plain English.',
    'Do not include any explanation or text outside the JSON array.',
    'Example output format:',
    '["Scenario one description", "Scenario two description"]',
    '',
  );

  if (mdFiles.length > 0) {
    sections.push('---', '## Test Plan Files', '');
    for (const file of mdFiles) {
      sections.push(`### ${file.path}`, '', file.content.trim(), '');
    }
  }

  sections.push('---', 'Return only the JSON array of test scenario strings.');

  return sections.join('\n');
}

/**
 * Calls ai.models.generateContent with automatic retry on 429 rate-limit errors.
 * Uses exponential backoff: 10s after attempt 1, 30s after attempt 2, 60s after attempt 3.
 */
async function generateWithRetry(ai, prompt) {
  const MAX_RETRIES = 3;
  const DELAYS_MS = [10_000, 30_000, 60_000];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: { maxOutputTokens: MAX_TOKENS },
      });
    } catch (err) {
      const isRateLimit =
        err.status === 429 ||
        err.statusCode === 429 ||
        (err.message && err.message.includes('429'));

      if (isRateLimit && attempt < MAX_RETRIES) {
        const delayMs = DELAYS_MS[attempt - 1];
        const delaySec = delayMs / 1000;
        console.log(`Rate limit hit, retrying in ${delaySec}s (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw err;
    }
  }
}

/**
 * Shared helper: creates a Gemini client. Reads GEMINI_API_KEY from the environment.
 */
function buildClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

/**
 * Shared helper: parses a JSON array of strings from Gemini's response.
 * Handles optional markdown code fences around the JSON.
 * If the JSON is truncated, recovers all complete string items found so far
 * and logs a warning rather than throwing.
 */
function parseJsonArray(raw, label) {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  // Fast path: valid JSON
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected a JSON array from Gemini (${label}), got: ${typeof parsed}`);
    }
    return parsed.filter((item) => typeof item === 'string' && item.trim().length > 0);
  } catch (err) {
    if (err.message.startsWith('Expected a JSON array')) throw err;
  }

  // Recovery path: extract every complete quoted string from the truncated text
  const items = extractCompleteStrings(jsonText);
  if (items.length > 0) {
    console.warn(
      `  Warning: response for "${label}" appears truncated — recovered ${items.length} item(s) from partial JSON.`
    );
    return items;
  }

  throw new Error(`Gemini returned a response that could not be parsed as JSON (${label}):\n${raw}`);
}

/**
 * Extracts all complete JSON-encoded strings from arbitrary text.
 * Used to salvage items from a truncated JSON array.
 */
function extractCompleteStrings(text) {
  const items = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    try {
      items.push(JSON.parse(match[0]));
    } catch {
      // skip malformed entries
    }
  }
  return items.filter((s) => typeof s === 'string' && s.trim().length > 0);
}

/**
 * Sends the bodies of linked GitHub issues and PRs to Gemini and returns a
 * consolidated list of requirements, user stories, and acceptance criteria
 * that a test plan should cover.
 *
 * @param {Array<{ url: string, type: string, body: string }>} artifacts - Linked issues / PRs
 * @returns {Promise<string[]>} Array of requirement strings
 */
async function extractRequirements(artifacts) {
  const ai = buildClient();
  const prompt = buildRequirementsPrompt(artifacts);
  const result = await generateWithRetry(ai, prompt);
  return parseJsonArray(result.text, 'requirements');
}

/**
 * Assembles the requirements prompt from the artifact bodies.
 */
function buildRequirementsPrompt(artifacts) {
  const sections = [];

  sections.push(
    'You are a Senior QA Engineer performing a thorough requirements analysis on linked GitHub issues',
    'and pull requests associated with a code change.',
    '',
    'Your task is to extract a comprehensive list of items that a test plan must cover.',
    'Think beyond happy-path functional requirements — consider every angle a QA expert would:',
    '',
    '1. **Functional requirements & user stories** — what the feature is supposed to do and for whom.',
    '2. **Negative scenarios** — what should NOT happen, actions that must be rejected, failure modes,',
    '   and invalid inputs. Prefix these with [NEGATIVE].',
    '3. **Edge cases** — boundary conditions, empty or null states, maximum/minimum limits,',
    '   concurrent operations, and race conditions. Prefix these with [EDGE CASE].',
    '4. **Authorization scenarios** — what read-only, restricted, or unauthenticated users can and',
    '   cannot do; privilege escalation paths that must be blocked. Prefix these with [AUTH].',
    '5. **Error handling cases** — how the system should behave when dependencies fail, inputs are',
    '   malformed, timeouts occur, or partial failures happen. Prefix these with [ERROR].',
    '',
    'Rules:',
    '- Ignore CI configuration, deployment instructions, changelogs, release notes, and anything',
    '  that does not describe a testable functional expectation.',
    '- Each item must be a single self-contained plain-English string.',
    '- Prefix each item with exactly one category tag: [FUNCTIONAL], [NEGATIVE], [EDGE CASE],',
    '  [AUTH], or [ERROR]. Functional requirements and user stories use [FUNCTIONAL].',
    '- Be thorough — it is better to include too many items than to miss a coverage gap.',
    '',
    'Return your answer as a **JSON array of strings** — one string per item.',
    'Do not include any explanation or text outside the JSON array.',
    'Example output format:',
    '["[FUNCTIONAL] User can submit a form with valid data",',
    ' "[NEGATIVE] Submitting the form with an empty required field shows a validation error",',
    ' "[EDGE CASE] Submitting the form with a field value at the maximum allowed character limit",',
    ' "[AUTH] A read-only user cannot submit the form",',
    ' "[ERROR] If the backend is unavailable, the form shows a user-friendly error message"]',
    '',
  );

  if (artifacts.length > 0) {
    sections.push('---', '## Linked Issues and Pull Requests', '');
    for (const artifact of artifacts) {
      const label = artifact.type === 'pr' ? 'Pull Request' : 'Issue';
      sections.push(`### ${label}: ${artifact.url}`, '');
      sections.push(artifact.body.trim() || '*(no description)*', '');
    }
  }

  sections.push('---', 'Return only the JSON array of requirement strings.');

  return sections.join('\n');
}

module.exports = { extractScenarios, extractRequirements };
