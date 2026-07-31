# Task

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works.
-->

## Goal

Build `handoff`: a portable session-state CLI that travels with a project as
`.handoff/`, so any AI coding tool (Claude Code, Claude Desktop, Cursor,
Codex, Gemini) can pick up work where the last tool left off — with full
knowledge of what was tried, what failed, what was decided, and what the
user corrected.

## Why

AI coding tools hit rate limits, drop context, or need to be swapped
mid-task. Today, every switch = "explain everything again". This tool is
the agent-to-agent handoff that eliminates that.

## Status (2026-07-31)

**v1 through v7 are shipped and published as `@zohartito/handoff@0.7.1`.**
`ROADMAP.md` is the authoritative shipped/next/cut list and changelog.
Validated live on Windows and macOS (full CLI pass 2026-07-31: 160/160
tests, every command exercised, pbcopy clipboard verified); Linux green
under the CI matrix but not yet run on a live desktop.

## Current mission

**Maintenance mode.** No feature work until the adoption gate fires
(npm >100 downloads/wk OR 3+ external issues OR community shoutout —
see ROADMAP "Future"). Until then:

1. Keep main green (CI matrix ubuntu/macos/windows × Node 22/24).
2. Triage dependabot weekly; TypeScript semver-majors are auto-ignored
   (TS7 breaks @types/node resolution — see closed PRs #7, #12).
3. Work the validation loose ends in `open-loops.md` when hardware is
   available (live Linux desktop; macOS launch-spawn; cursor real-data
   parse).

## Constraints

- File format stays human-readable markdown + JSON/JSONL. No binary DBs.
- `.handoff/` is portable: copy the folder, keep the context.
- Tool-agnostic primer — no Claude-specific idioms in the shared files.
- Zero runtime dependencies beyond Node + commander.
- Windows must work (stdout flush quirk, path encoding quirks — both solved).
- Node >=22.5 (node:sqlite for the cursor adapter).
