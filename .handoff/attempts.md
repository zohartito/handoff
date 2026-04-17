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

## 2026-04-17T04:25:43.861Z
**tried:** validated pbcopy clipboard branch on macOS

**fix:** handoff switch codex --no-launch populated pasteboard; pbpaste returned primer
---

## 2026-04-17T04:26:04.132Z
**tried:** validated install + version on macOS 0.4.0

**fix:** handoff --version printed 0.4.0; node 'find package.json' path resolver works under /usr/local/lib on mac
---

## 2026-04-17T04:26:04.174Z
**tried:** validated pbcopy clipboard branch on macOS

**fix:** handoff switch codex --no-launch populated pasteboard; pbpaste returned primer
---

## 2026-04-17T04:34:48.731Z
**tried:** install + version on macOS

**fix:** npm i -g @zohartito/handoff@0.4.0 → handoff --version prints 0.4.0
---

## 2026-04-17T04:34:48.774Z
**tried:** pbcopy clipboard cascade on macOS

**fix:** handoff switch codex --no-launch copies primer silently; pbpaste shows # HANDOFF PRIMER
---

## 2026-04-17T04:34:48.813Z
**tried:** launcher PATH resolution on macOS

**fix:** which codex/cursor/code all resolve: /opt/homebrew/bin/codex, /usr/local/bin/cursor, /usr/local/bin/code
---

## 2026-04-17T04:34:48.852Z
**tried:** Cursor FS layout on macOS

**fix:** ingest --from cursor --list scans ~/Library/Application Support/Cursor/User/workspaceStorage (correct Unix path, cursorUserDir branch fires)
---

## 2026-04-17T04:34:48.891Z
**tried:** Claude Code project-path encoding under Unix roots

**fix:** ingest --from claude-code --list returns sessions from /Users/zohartito/.claude/projects/-Users-zohartito/ — encodeProjectPath handles / and leading-slash
---

## 2026-04-17T04:34:48.929Z
**tried:** Obsidian sync on Synology-mounted vault (macOS)

**fix:** handoff obsidian sync --vault ~/SynologyDrive/Obsidian/OpenClaw-Brain → 1 daily, 7 decisions, 2 rules; Daily/2026-04-16.md created
---
