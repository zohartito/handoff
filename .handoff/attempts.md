# Attempts

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works. When an agent picks up this project, it should read every
file in this directory before taking action.
-->

<!--
Failed approaches with full error traces. This is the file that prevents
the next agent from repeating mistakes.

Each entry:
- what was tried
- full error output (verbatim — don't summarize it away)
- what the fix was, or how it was abandoned
- optional: agent-written summary

Use `handoff attempt "tried X" --error "trace" --fix "what worked"` to append.
-->

## 2026-04-16T20:07:20.437Z
**tried:** forgot pathToFileURL in bin shim

**error:**

```
ERR_UNSUPPORTED_ESM_URL_SCHEME: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'c:'
```

**fix:** import pathToFileURL from node:url and wrap the compiled/source path before passing to dynamic import()
---

## 2026-04-16T23:24:13.078Z
**tried:** write hook JSON via process.stdout.write then return

**error:**

```
when stdout is redirected (> file) or piped further, output is 0 bytes — process exits before Node flushes the write on Windows
```

**fix:** wrap in Promise that awaits the write callback before returning: await new Promise(r => process.stdout.write(s, r))
---

## 2026-04-17T01:26:03.166Z
**tried:** ingest stopped at first matching project dir

**error:**

```
fresh CC session in handoff/ created C--Users-zohar-4ta16fp-handoff; ingest's findClaudeProjectDir returned early, never looked at the parent C--Users-zohar-4ta16fp where the build history lived. Fresh agent ingested itself.
```

**fix:** walk up the path AND aggregate across every existing project dir; resolveSessionFileAcross / listSessionsAcross iterate over them
---

## 2026-04-17T01:46:52.843Z
**tried:** suppress node:sqlite ExperimentalWarning inside adapters/cursor.ts openReadOnly wrapper

**error:**

```
(node:XXXX) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

**fix:** hoist the process.emitWarning override into bin/handoff.mjs (CLI shim), before any src/* modules load. The warning fires at node:sqlite module resolution time, which is earlier than any dynamic import in the adapter.

**summary:** tried to colocate warning suppression with sqlite usage site; had to hoist to the shim because the warning fires at module-resolution time
---

## 2026-04-17T01:46:55.990Z
**tried:** use bubble.workspaceUris array to filter Cursor composers by project path

**error:**

```
most bubbles returned empty/missing workspaceUris; filtering by project yielded 0 sessions even for the active workspace
```

**fix:** read workspace-scoped state.vscdb (workspaceStorage/<hash>/) and aggregate composer IDs from ItemTable keys 'composer.composerData' (selected/lastFocused) and 'aiService.generations' (recent LLM generation log). Parent-walk to include ancestor workspaces, matching claude-code's behavior.

**summary:** bubble.workspaceUris is unreliable; authoritative linkage is workspace-scoped ItemTable
---
