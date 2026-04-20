const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL = 'gemini-2.0-flash';
const MAX_TOKENS = 4096;

/**
 * Calls model.generateContent with automatic retry on 429 rate-limit errors.
 * Uses exponential backoff: 10s after attempt 1, 30s after attempt 2, 60s after attempt 3.
 */
async function generateWithRetry(model, prompt) {
  const MAX_RETRIES = 3;
  const DELAYS_MS = [10_000, 30_000, 60_000];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await model.generateContent(prompt);
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

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  });

  const prompt = buildReportPrompt(scenarios, requirements);
  const result = await generateWithRetry(model, prompt);
  const raw = result.response.text();

  return parseReport(raw, requirements);
}

/**
 * Assembles the comparison prompt.
 */
function buildReportPrompt(scenarios, requirements) {
  const sections = [];

  sections.push(
    'You are a QA engineer performing a test coverage analysis.',
    '',
    'You are given two lists:',
    '1. **Test Scenarios** — what is currently covered by the test plan.',
    '2. **Requirements** — what the feature or fix is supposed to do, based on linked issues and PRs.',
    '',
    'Your task is to classify **each requirement** into exactly one of three categories:',
    '- **COVERED**: there is at least one test scenario that clearly addresses this requirement.',
    '- **MISSING**: no test scenario addresses this requirement.',
    '- **UNCLEAR**: a scenario partially addresses it or the mapping is ambiguous.',
    '',
    'Return your answer as a JSON object with exactly three keys: "covered", "missing", "unclear".',
    'Each key maps to an array of requirement strings (copied verbatim from the requirements list).',
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
 * Falls back to placing all requirements in "unclear" if parsing fails.
 */
function parseReport(raw, requirements) {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(
      `Gemini returned a response that could not be parsed as JSON:\n${raw}`
    );
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
  // If a requirement appears in multiple buckets, the highest-priority one wins.
  const inCovered = new Set(covered);
  missing = missing.filter((r) => !inCovered.has(r));
  const inMissing = new Set(missing);
  unclear = unclear.filter((r) => !inCovered.has(r) && !inMissing.has(r));

  // Ensure every requirement appears in exactly one bucket — anything Gemini
  // dropped goes into unclear so nothing is silently lost.
  const classified = new Set([...covered, ...missing, ...unclear]);
  const dropped = requirements.filter((r) => !classified.has(r));
  unclear.push(...dropped);

  return { covered, missing, unclear };
}

module.exports = { generateReport };
