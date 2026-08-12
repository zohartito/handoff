# LEARNINGS — handoff

Durable learnings appended by the `retrieval-eval` loop (see `scripts/retrieval-eval.mjs`).
Distinct from `.claude/lessons.md` (human corrections consolidated by `dream`):
this file is the loop's own machine-appended run log.

Format, newest last, one line per run:
`<ISO-8601-UTC> [retrieval-eval] <PASS|FAIL> — <note>`

## Seed notes
- The loop re-runs the retrieval-quality guards nightly: `tests/retrieval.test.ts`
  (relevance ranking / IDF / recurrence) and `tests/evaluate.test.ts` (precision /
  recall / F1 + strategy sweep). It reuses `tsc -p tsconfig.test.json` + `node --test`
  and does NOT duplicate the suites.
- A retrieval/ranking regression that no PR happened to touch is exactly what this
  nightly catches — the PR CI only runs when a PR is opened.

<!-- loop appends below this line -->
