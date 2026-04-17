# Task

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works.
-->

## Goal

Build `handoff`: a portable session-state CLI that travels with a project as
`.handoff/`, so any AI coding tool (Claude Code, Cursor, Codex, Gemini) can
pick up work where the last tool left off — with full knowledge of what was
tried, what failed, what was decided, and what the user corrected.

## Why

AI coding tools hit rate limits, drop context, or need to be swapped
mid-task. Today, every switch = "explain everything again". This tool is
the agent-to-agent handoff that eliminates that.

## Done looks like (v1)

- `handoff init` scaffolds `.handoff/` in any project — **done**
- `handoff attempt|decide|correct|save|status` lifecycle commands — **done**
- `handoff prime --tool <tool>` emits a primer for any target tool — **done**
- `handoff install --tool claude-code` prints integration recipe — **done**
- Claude Code hooks (SessionStart / Stop / StopFailure) auto-inject the
  primer into every new session — **done**
- `handoff ingest --from claude-code` pulls past session transcripts into
  `.handoff/` — **done**
- `handoff ingest --from cursor` pulls past Cursor sessions (reads
  `state.vscdb` via built-in `node:sqlite`) — **done**
- Real cross-tool handoff test: start in one tool, hand off mid-task, verify
  the other picks up without re-explanation — **next**
- Publish to GitHub + `npm install -g` — **after cross-tool test**

## Constraints

- File format stays human-readable markdown + JSON/JSONL. No binary DBs.
- `.handoff/` is portable: copy the folder, keep the context.
- Tool-agnostic primer — no Claude-specific idioms in the shared files.
- Zero runtime dependencies beyond Node + commander.
- Windows must work (stdout flush quirk, path encoding quirks — both solved).

## Next task (for whichever tool picks this up)

The "Next task for Cursor" listed here previously — building
`handoff ingest --from cursor` — is done. See `.handoff/decisions.md` for
the schema reverse-engineering choices and `src/adapters/cursor.ts` for the
implementation.

The next meaningful step is the **round-trip handoff test**:

1. Start a small real task here (e.g. "add `--from codex` adapter"),
   do a few turns in tool A, run `handoff switch <tool-b>`.
2. In tool B, confirm the primer + `.handoff/` state is enough to continue
   without asking the user to re-explain.
3. If anything is missing from the primer or from `ingest`, fix it here,
   then re-run. That gap is the real product signal.
