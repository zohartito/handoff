# Corrections

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works. When an agent picks up this project, it should read every
file in this directory before taking action.
-->

<!--
Times the prior agent got it wrong, and what the user actually meant.
This is the user's implicit rubric — their real preferences as revealed
by feedback, not as stated in prefs files.

Use `handoff correct "what I did" --user-said "their feedback"` to append.
-->

## 2026-04-16T20:07:21.261Z
**agent did:** first built SMS/Postgres agent-routing system

**user said:** wrong product, I meant tool-to-tool not user-to-user

**lesson:** when user describes multi-actor scenarios, ask whether actors are humans or AI tools before implementing
---

## 2026-04-17T03:48:12.179Z
**agent did:** was going to add cursor MCP server (v2)

**user said:** handoff switch + ingest cursor already cover it

**lesson:** prefer file-based path when it works; don't add moving parts for their own sake
---
