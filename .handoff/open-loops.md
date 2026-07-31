# Open Loops

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works. When an agent picks up this project, it should read every
file in this directory before taking action.
-->

<!--
Unfinished threads. Things we started but didn't finish. Questions blocked
on the user. Each item should be actionable: what's the next thing someone
(agent or user) would do.
-->

- [ ] Live Linux desktop validation: clipboard cascade (wl-copy → xclip → xsel) and detached tool launch have only run under CI, never on real Linux hardware. See `CROSS-PLATFORM.md` → "Requires live testing".
- [ ] macOS launch-spawn validation: `handoff switch <tool>` without `--no-launch` (detached spawn of cursor/claude/codex/gemini) hasn't been observed live; clipboard path is verified.
- [ ] `ingest --from cursor` parse of a real populated `state.vscdb` on macOS (path scan verified, parse not yet observed with real data).
- [ ] Review the two unmerged remote branches `wip/autosync-mac-handoff` and `wip/autosync-pc-handoff` (each 1 commit ahead of main): PR them or confirm abandoned, then delete.
- [ ] `local-llm-radar` PR #37 (typescript 7.0.2 bump): apply the same resolution as handoff PR #12 — close it and add a dependabot ignore for typescript semver-majors (ts-jest peer range also excludes TS7 there).
- [ ] Adoption gate for v8+ (auto-rule promotion, more adapters): don't build until npm >100 downloads/wk OR 3+ external issues OR a community shoutout. Check occasionally: `npm view @zohartito/handoff` + repo issues.
