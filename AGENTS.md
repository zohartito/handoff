# handoff — Claude Code project memory

## What this is
Portable session-state CLI for AI coding tools. When you switch mid-task between Claude Code, Cursor, Codex, or Gemini (usually because you hit a rate limit), `handoff` gives the next tool the same co

## How to verify a change
- Tests: `npm test`
- Lint:  `npm run lint`
- First-run walkthrough: `npm run build && node scripts/first-run-walkthrough.mjs`.
  Runs in a temporary repo and compares the current build with the recorded
  baseline in `docs/first-run-before.json`; see `docs/first-run-walkthrough.md`.

## Self-improving loop (close the loop)
Run an agent until it verifies its own output, then commit:
```
python3 ~/.agent-kit/verify_loop.py --task "<what to do>" --verify "npm test && npm run lint" --cwd . --max-iters 5 --commit
```

## Layout
`.claude/`, `.github/`, `.handoff/`, `.planning/`, `bin/`, `scripts/`, `src/`, `templates/`, `tests/`

## Loops
- **`retrieval-eval` (SCHED, nightly)** — retrieval-quality regression run.
  - Runner: `scripts/retrieval-eval.mjs` — rebuilds `tsc -p tsconfig.test.json` and re-runs
    `tests/retrieval.test.ts` + `tests/evaluate.test.ts` via `node --test`; emits `loop-result/v1`
    JSON; exit code = gate. Reuses the existing suites (does NOT duplicate them).
  - Schedule: `scripts/launchd/com.zohartito.handoff.retrieval-eval.plist` (nightly 03:00).
    NOT loaded — load with `launchctl load ~/Library/LaunchAgents/com.zohartito.handoff.retrieval-eval.plist`.
  - Flywheel: local runs append to `.claude/LEARNINGS.md`; `--ci`/`--dry-run` skip the append.
  - Note: this is the scheduled complement to the session-end self-improving loop
    (`verify_loop.py`) — it guards ranking/metric drift when no PR is open.

## Log lifecycle (append → compact → archive)
The log files (`attempts.md`, `corrections.md`, `decisions.md`) are append-only, so they
grow without bound (same failure re-logged on every recurrence). `handoff compact`
(`src/commands/compact.ts`) is the lifecycle: dedupe byte-identical entries into one with a
`**seen:** N×` provenance line, relocate the oldest distinct entries beyond `--keep` into a
verbatim `## Archive` fold, and validate (no distinct entry dropped, every event still counted)
before replacing the file. It RELOCATES and COUNTS — never rewrites prose (determinism
boundary: no lossy summarization of load-bearing traces). Idempotent.

## Conventions
- Follow CONVENTIONS.md (if present) and the global ~/.claude/CLAUDE.md.
- Make surgical, single-purpose changes; match existing style.

## Evidence freshness
`decide` and `correct` accept `--evidence <paths...>` (MCP: `evidence: string[]`).
`src/commands/evidence.ts` hashes repo-contained files and checks recorded hashes;
`handoff stale --check` exits 1 for changed, missing or unreadable evidence on active entries;
an unreadable file flags its entry and never aborts a primer.
Primers annotate stale evidence at render time without changing stored entries.
Regression coverage lives in `tests/evidence.test.ts`.

## Lessons
Corrections, gotchas, and "don't do X again" notes accumulate in `.claude/lessons.md`
and are consolidated by the `dream` skill. Read them before non-trivial work.

## Agent rules (all harnesses)
- Determinism boundary: anything that must be EXACT (money, geometry, safety limits, scoring, pricing) lives in code; the model only orchestrates and judges.
- Keep this file current: when you change how this repo is run, tested, or structured, update AGENTS.md in the same commit. Keep it under ~150 lines.

## Agent-to-agent (sideways) handoff
The same payload discipline works between two agents running *concurrently*, not just one
session handing off to the next across time. A persists the `.handoff/` payload (`init` ->
author task/progress/open-loops -> `decide` -> `save`); a fresh, concurrent B loads it with
`prime` and finishes. The payload is the ONLY channel — no shared context, no back-channel to
ask A anything, and it's a one-shot point-in-time cut with no locking, so whatever A does not
write down is lost to B. Two carry-over caveats seen in practice: `prime`'s preamble +
rate-limit protocol are framed for a *temporal* resume ("picking up work previously in
progress"), which reads wrong for concurrent agents; and HTML comments in payload files get
dropped by the primer renderer, so never put a load-bearing token inside `<!-- -->`.
Worked example + findings: `multi-agent-lab/experiments/handoff-sideways/` (run_a.sh ->
run_b.sh, NOTES.md).
