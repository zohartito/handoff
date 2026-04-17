# Progress

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works. When an agent picks up this project, it should read every
file in this directory before taking action.
-->

<!--
What's done, what's in flight, what's blocked, what's next.
Update as state changes. Delete stale items.
-->

## Done

- `handoff init` scaffolds `.handoff/` in any project
- `handoff attempt|decide|correct|save|status` lifecycle commands
- `handoff prime --tool <tool>` emits a primer for any target tool
- `handoff install --tool claude-code` prints integration recipe
- Claude Code hooks (SessionStart / Stop / StopFailure) auto-inject the primer into every new session
- `handoff ingest --from claude-code` pulls past session transcripts into `.handoff/`
- `handoff ingest --from cursor` reads Cursor's SQLite state.vscdb (workspace + global) via `node:sqlite` and emits the same markdown shape as `--from claude-code`
- Windows stdout flush quirk solved (await stdout.write callback)
- ESM `pathToFileURL` wrapping for Windows paths in bin shim
- `node:sqlite` `ExperimentalWarning` suppressed at the shim so `ingest --from cursor` stays quiet on stdout

## In flight

_(none)_

## Blocked

_(none)_

## Next

- Real cross-tool handoff test: Claude Code → Cursor round-trip — start a task in one, switch, verify zero re-explanation
- Publish to GitHub + `npm install -g` (after cross-tool test passes)
