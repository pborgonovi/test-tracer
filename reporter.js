const { GoogleGenAI } = require('@google/genai');

const MODEL = 'gemini-3.1-pro-preview';
const MAX_TOKENS = 8192;

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
 * Compares a list of test scenarios against a list of requirements using
 * Gemini and classifies each requirement as COVERED, MISSING, or UNCLEAR.
 *
 * @param {string[]} scenarios    - Plain-English test scenarios from the test plan
 * @param {string[]} requirements - Plain-English requirements from linked artifacts
 * @returns {Promise<{ covered: string[], missing: string[], unclear: string[] }>}
 */
async function generateReport(scenarios, requirements) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set.');
  }

  if (requirements.length === 0) {
    return { covered: [], missing: [], unclear: [] };
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const prompt = buildReportPrompt(scenarios, requirements);
  const result = await generateWithRetry(ai, prompt);
  const raw = result.text;

  return parseReport(raw, requirements);
}

/**
 * Assembles the comparison prompt.
 */
function buildReportPrompt(scenarios, requirements) {
  const sections = [];

  sections.push(
    'You are a Senior QA Engineer performing a test coverage analysis.',
    '',
    'You are given two lists:',
    '1. **Test Scenarios** — what is currently covered by the test plan.',
    '2. **Requirements** — what the feature or fix is supposed to do, based on linked issues and PRs.',
    '',
    'Your task is to classify **each requirement** into exactly one of three categories.',
    'Read the classification rules carefully — the bar for COVERED is intentionally generous:',
    '',
    '## Classification Rules',
    '',
    '**COVERED** — use this when any scenario in the test plan tests the same underlying behavior,',
    'even if the wording is completely different. Do not require an exact or near-exact phrase match.',
    'If a scenario would catch a regression in this requirement, it is COVERED.',
    '',
    '**MISSING** — use this only when there is genuinely no scenario that touches this behavior at all.',
    'If a requirement is about a feature, error case, or user action and no scenario comes close, it is MISSING.',
    '',
    '**UNCLEAR** — use this only when a scenario partially covers the requirement but leaves part of it',
    'untested, or when the mapping is genuinely ambiguous and you cannot confidently choose COVERED or MISSING.',
    'Do not use UNCLEAR as a default — only use it when partial coverage is evident.',
    '',
    '## Classification Examples',
    '',
    'Requirement: "[FUNCTIONAL] A user can submit a search query and see matching results"',
    'Scenario: "Verify that entering a keyword in the search bar returns a filtered list of results"',
    '→ COVERED — same behavior, different wording.',
    '',
    'Requirement: "[NEGATIVE] Submitting an empty search query shows a validation error"',
    'Scenario: "Verify that the search bar shows an error message when submitted without input"',
    '→ COVERED — semantically identical.',
    '',
    'Requirement: "[AUTH] A read-only user cannot delete a record"',
    'Scenario: "Verify that the delete button is hidden for users with viewer permissions"',
    '→ COVERED — the scenario validates the authorization constraint.',
    '',
    'Requirement: "[EDGE CASE] Search results are paginated when more than 50 results are returned"',
    'Scenario: "Verify that search results display correctly"',
    '→ UNCLEAR — the scenario touches search results but does not test pagination specifically.',
    '',
    'Requirement: "[ERROR] If the API times out, the UI shows a user-friendly error banner"',
    '(no scenario mentions API failures or timeouts)',
    '→ MISSING — no scenario tests this behavior.',
    '',
    '## Output Format',
    '',
    'Return your answer as a JSON object with exactly three keys: "covered", "missing", "unclear".',
    'Each key maps to an array of requirement strings copied verbatim from the requirements list.',
    'Every requirement must appear in exactly one array. Do not add any text outside the JSON object.',
    '',
    'Example output format:',
    '{"covered": ["req a"], "missing": ["req b"], "unclear": ["req c"]}',
    '',
  );

  sections.push('---', '## Test Scenarios', '');
  if (scenarios.length > 0) {
    scenarios.forEach((s, i) => sections.push(`${i + 1}. ${s}`));
  } else {
    sections.push('*(none — the test plan contains no scenarios)*');
  }

  sections.push('', '---', '## Requirements', '');
  requirements.forEach((r) => sections.push(`- ${r}`));

  sections.push(
    '',
    '---',
    'Return only the JSON object with "covered", "missing", and "unclear" arrays.',
  );

  return sections.join('\n');
}

/**
 * Parses the JSON report from Gemini's response.
 * If the JSON is truncated, recovers whatever complete bucket arrays are present
 * and logs a warning. Any requirements not classified are placed in unclear.
 */
function parseReport(raw, requirements) {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  let parsed;
  const isClean = tryParse(jsonText, (result) => { parsed = result; });

  if (!isClean) {
    // Recovery: extract each bucket's strings independently from the partial text
    console.warn('  Warning: report response appears truncated — recovering partial classification.');
    parsed = recoverTruncatedObject(jsonText);
  }

  const normalize = (val) =>
    Array.isArray(val)
      ? val
          .filter((x) => typeof x === 'string' && x.trim())
          // Strip any leading number prefix Gemini may have echoed back (e.g. "1. ")
          .map((x) => x.replace(/^\d+\.\s*/, '').trim())
      : [];

  let covered = normalize(parsed.covered);
  let missing = normalize(parsed.missing);
  let unclear = normalize(parsed.unclear);

  // Enforce strict single-bucket membership: covered > missing > unclear.
  const inCovered = new Set(covered);
  missing = missing.filter((r) => !inCovered.has(r));
  const inMissing = new Set(missing);
  unclear = unclear.filter((r) => !inCovered.has(r) && !inMissing.has(r));

  // Anything Gemini dropped goes into unclear so nothing is silently lost.
  const classified = new Set([...covered, ...missing, ...unclear]);
  const dropped = requirements.filter((r) => !classified.has(r));
  unclear.push(...dropped);

  return { covered, missing, unclear };
}

/**
 * Attempts JSON.parse; calls setter with result and returns true on success.
 */
function tryParse(text, setter) {
  try {
    setter(JSON.parse(text));
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts the covered/missing/unclear arrays from a truncated JSON object
 * by scanning each bucket's section independently for complete quoted strings.
 */
function recoverTruncatedObject(text) {
  const result = { covered: [], missing: [], unclear: [] };

  for (const key of ['covered', 'missing', 'unclear']) {
    // Match from the key's "[" to the next top-level key or end of string
    const sectionMatch = text.match(
      new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)(?=\\s*"(?:covered|missing|unclear)"\\s*:|$)`)
    );
    if (!sectionMatch) continue;

    const section = sectionMatch[1];
    const pattern = /"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = pattern.exec(section)) !== null) {
      try {
        const str = JSON.parse(m[0]);
        if (typeof str === 'string' && str.trim()) result[key].push(str);
      } catch {
        // skip malformed entries
      }
    }
  }

  return result;
}

module.exports = { generateReport };
