---
description: Hand off the current session to another AI tool via `handoff switch`.
argument-hint: <tool>
allowed-tools: Bash(handoff switch:*)
---

Run `handoff switch $1` using the Bash tool.

- Target tool: **$1** (one of `claude-code`, `cursor`, `codex`, `gemini`, `generic`).
- The command saves session state, rebuilds the primer, copies it to the
  clipboard, and launches the target tool in the current working directory.
- After it finishes, print the last line of the CLI's stdout so the user
  sees the confirmation (e.g. "primer copied to clipboard, launching cursor…").
- If `$1` is empty or not one of the allowed tools, ask the user which tool
  to switch to before running anything.

Do not log anything to `.handoff/` yourself — `handoff switch` already
refreshes `environment.md` via `handoff save`.
