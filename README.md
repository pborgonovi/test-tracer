# test-tracer

Automatically compares a markdown test plan against the requirements buried in linked GitHub issues — and surfaces what's covered, what's missing, and what needs a closer look.

---

## How to Run

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A GitHub personal access token with `repo` read access
- A Gemini API key (from [Google AI Studio](https://aistudio.google.com/))

### Installation

```bash
git clone https://github.com/your-username/test-tracer.git
cd test-tracer
npm install
```

### .env setup

Create a `.env` file in the project root:

```
GITHUB_TOKEN=your_github_token_here
GEMINI_API_KEY=your_gemini_api_key_here
```

### Run

```bash
node index.js <github-pr-url> --repo <path-to-local-repo>
```

**Example:**

```bash
node index.js https://github.com/elastic/kibana/pull/123456 --repo /Users/you/kibana
```

The tool will:
1. Fetch the `.md` files modified in the PR
2. Crawl linked GitHub issues up to 2 levels deep
3. Ask if you want to add any extra issue URLs for context
4. Extract test scenarios from the test plan files using Gemini
5. Extract requirements, edge cases, auth scenarios, and error cases from the linked issues
6. Compare the two lists and print a structured coverage report

---

## Important: How to interpret the results

test-tracer is designed to be a first-pass analysis tool, not a definitive audit.

Results are non-deterministic — because the tool relies on a Large Language Model, the same PR can produce slightly different classifications across runs. The `unclear` category exists precisely to flag items that need human judgment, not items that are definitively covered or missing.

The real value is surfacing likely gaps quickly. What would take a reviewer hours to cross-reference manually happens in seconds. Always treat the `missing` and `unclear` buckets as starting points for human review, not as final verdicts.

---

## Example Output

```
============================================================
  TEST COVERAGE REPORT
============================================================
  Total requirements : 54
  Covered            : 35 (65%)
  Missing            : 15
  Unclear            : 4
============================================================

  COVERED
    1. [FUNCTIONAL] A user with editor access can create and save a new test plan document
    2. [NEGATIVE] Submitting the form with a missing required field displays an inline validation error
    3. [AUTH] A read-only user cannot edit or delete an existing test plan

  MISSING
    1. [EDGE CASE] Saving a test plan with a title at the maximum allowed character limit (255 chars)
    2. [ERROR] If the Gemini API is unavailable, the tool surfaces a user-friendly error and exits cleanly
    3. [NEGATIVE] An unauthenticated request to the test plan API returns a 401 response

  UNCLEAR
    1. [EDGE CASE] Concurrent edits to the same test plan by two users — last write wins or conflict shown
    2. [AUTH] Behaviour when a user's permissions are downgraded while they have the editor view open

============================================================
```

---

## Project Structure

```
index.js       — CLI entry point: argument parsing, orchestration, interactive prompts
github.js      — GitHub REST API: fetch PR files, crawl linked issues recursively
extractor.js   — Gemini prompts: extract test scenarios and categorised requirements
reporter.js    — Gemini prompt: compare scenarios vs requirements, classify coverage
```

---

## Problem

On the Detection & Response team at Elastic, developers build automated tests for new features and write test plans in markdown files that live inside the Kibana repository alongside the code. As a QA professional on the team, reviewing these test plans means manually chasing down the linked epic, opening every referenced issue across multiple GitHub repositories, and cross-referencing requirements, edge cases, negative scenarios, and authorization scenarios against what the test plan actually covers. This process is time-consuming, error-prone, and easy to get wrong, especially when a single feature spans dozens of issues spread across `elastic/kibana`, `elastic/security-team`, and other repos.

---

## Why It Matters

QA Engineers and Developers on teams that use GitHub for planning and markdown files for test plans spend a disproportionate amount of time on this kind of review. The gap between "what we said we'd test" and "what we actually need to test" is rarely caught until something breaks in production. test-tracer closes that gap automatically on every PR.

---

## Language Used

JavaScript (Node.js).

Built by a non-developer using [Cursor](https://cursor.com) and AI assistance. No prior Node.js or API integration experience was required, the entire project was scaffolded, debugged, and iterated through conversation with Cursor's Agent mode.

---

## How Cursor Helped

test-tracer was built entirely inside Cursor using Agent mode, no code was written by hand.

Each phase of the project was tackled through a conversation:

- **Scaffolding** — the CLI entry point, argument parsing, and URL validation were created by describing the desired behaviour in plain English. Cursor generated the initial structure and wired the pieces together.
- **GitHub integration** — fetching PR file lists, reading blob contents, and crawling linked issues recursively were built by asking Cursor to implement each step, then iterating on edge cases like pagination, `lastIndex` bugs in regex, and base64 decoding.
- **AI extraction** — the Gemini integration for extracting test scenarios and requirements was built by describing the prompt engineering goals, then refining the instructions iteratively until the output was structured and reliable.
- **Coverage reporting** — the comparison logic and deduplication bugs (requirements appearing in two buckets simultaneously) were fixed by describing the expected behaviour and letting Cursor reason through the priority rules.
