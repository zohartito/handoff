# Decisions

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works. When an agent picks up this project, it should read every
file in this directory before taking action.
-->

<!--
Key choices that have been made, with reasoning. New agents: read this
before proposing a different approach — if a decision is here, it's been
argued once already.

Use `handoff decide "chose X" --because "reason"` to append.
-->

## 2026-04-16T20:07:20.740Z
**chose:** Node + TypeScript over Python

**because:** distributable via npm, matches the AI tools we integrate with (Claude Code, Cursor are both node-based)

**considered:** Python, Go
---

## 2026-04-16T20:07:21.003Z
**chose:** file-based .handoff/ directory

**because:** local-first, tool-agnostic, agents can read/write with standard fs tools

**considered:** cloud API, sqlite
---

## 2026-04-17T01:46:16.404Z
**chose:** use node:sqlite (built-in) for Cursor DB reads

**because:** Node 24 ships a built-in sqlite module, so we can read Cursor's state.vscdb without violating the zero-runtime-deps constraint (only Node + commander allowed)

**considered:** better-sqlite3 (adds binary dep), sql.js (adds ~700KB), shell out to sqlite3 CLI (not installed on Windows by default)
---

## 2026-04-17T01:46:24.365Z
**chose:** normalize Cursor tool names to Claude Code PascalCase vocabulary

**because:** user's constraint: 'Output format must match renderMarkdown output exactly, so downstream tools treat claude-code and cursor sources identically'. Mapping read_file_v2 -> Read, run_terminal_command_v2 -> Bash, etc. makes the Tool activity section directly comparable across sources.

**considered:** keep snake_case names verbatim, emit both original and normalized
---

## 2026-04-17T01:46:28.860Z
**chose:** use workspace-scoped state.vscdb for workspace<->composer linkage

**because:** composers in the global DB have no workspaceId field; the reliable linkage is workspaceStorage/<hash>/state.vscdb -> ItemTable keys composer.composerData (selected/lastFocused ids) and aiService.generations (recent generation log with composerId per entry). Parent-walk aggregates across direct + parent workspaces, matching the claude-code ingest model.

**considered:** scan bubble.workspaceUris (mostly empty), use composer.createdAt heuristic (unreliable)
---

## 2026-04-17T03:48:12.068Z
**chose:** publish to npm as @zohartito/handoff (scoped)

**because:** all unscoped handoff-* names were squatted

**considered:** handoff-cli, handoffjs, handoff-ai
---

## 2026-04-17T04:15:10.146Z
**chose:** continue v1.6 mac/linux validation on MacBook via Synology sync

**because:** dogfooding the product — handing off between Windows and Mac is literally what this tool exists for
---

## 2026-04-17T05:17:41.544Z
**chose:** persist imported ingest summaries in .handoff/ingested-context.md

**because:** switch/prime need transcript-level context after ingest, before task/progress are manually updated

**considered:** stdout-only ingest, LLM auto-populates task/progress from transcript
---
