# handoff — Claude Code project memory

## What this is
Portable session-state CLI for AI coding tools. When you switch mid-task between Claude Code, Cursor, Codex, or Gemini (usually because you hit a rate limit), `handoff` gives the next tool the same co

## How to verify a change
- Tests: `npm test`
- Lint:  `npm run lint`

## Self-improving loop (close the loop)
Run an agent until it verifies its own output, then commit:
```
python3 ~/.agent-kit/verify_loop.py --task "<what to do>" --verify "npm test && npm run lint" --cwd . --max-iters 5 --commit
```

## Layout
`.claude/`, `.github/`, `.handoff/`, `.planning/`, `bin/`, `scripts/`, `src/`, `templates/`, `tests/`

## Conventions
- Follow CONVENTIONS.md (if present) and the global ~/.claude/CLAUDE.md.
- Make surgical, single-purpose changes; match existing style.

## Lessons
Corrections, gotchas, and "don't do X again" notes accumulate in `.claude/lessons.md`
and are consolidated by the `dream` skill. Read them before non-trivial work.

## Agent rules (all harnesses)
- Determinism boundary: anything that must be EXACT (money, geometry, safety limits, scoring, pricing) lives in code; the model only orchestrates and judges.
- Keep this file current: when you change how this repo is run, tested, or structured, update AGENTS.md in the same commit. Keep it under ~150 lines.
