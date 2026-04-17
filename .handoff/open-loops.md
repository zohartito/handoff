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

- [x] ~~Write `handoff ingest --from cursor` (companion to `--from claude-code`) so Cursor sessions can be imported the same way~~ — shipped in `src/adapters/cursor.ts`; output shape matches `renderMarkdown` exactly (section-for-section identical)
- [ ] Run end-to-end cross-tool handoff test: start a task in Claude Code, hand off to Cursor mid-task (or vice-versa), verify the receiving tool picks up context without re-explanation
- [ ] Add `ingest --from codex` and `--from gemini` adapters (not urgent; current two cover the primary handoff pair)
- [ ] Publish to GitHub (public repo)
- [ ] Publish to npm so `npm install -g handoff` works
- [ ] Document the Claude Code hook install recipe in the README (SessionStart / Stop / StopFailure)
