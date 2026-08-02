# handoff — Claude Code plugin

Installs handoff's hooks (and, once enabled, its MCP server) in one step, so
they register **globally** instead of per-repo.

## Why this exists

The documented setup used to be "paste this JSON block into
`~/.claude/settings.json`". That step can silently not happen — and when it
doesn't, handoff appears installed while doing nothing outside whatever repo
you happened to configure. A plugin removes the manual edit, and its hooks
*merge* with your existing settings rather than replacing them.

## Install

From this repo (it doubles as the marketplace):

```
/plugin marketplace add zohartito/handoff
/plugin install handoff@handoff-tools
```

To develop against a local checkout without installing:

```
claude --plugin-dir ./plugin
```

## What it registers

| Hook | Does |
|---|---|
| `SessionStart` | injects the primer (also re-fires after a compaction) |
| `UserPromptSubmit` | re-surfaces standing rules mid-session; silent when there are none |
| `Stop` | refreshes state and auto-captures corrections + failed attempts |
| `PreCompact` | same auto-capture, before the transcript is compacted |
| `StopFailure` (`rate_limit`) | logs the rate-limit event and suggests a tool to switch to |

## MCP server

The plugin also registers handoff's MCP server, so the agent can read and write
`.handoff/` as tools mid-conversation instead of via a pasted primer. Tools:
`handoff_context`, `handoff_open_loops`, `handoff_status`,
`handoff_log_correction`, `handoff_log_attempt`, `handoff_log_decision`.

It resolves the project root from `CLAUDE_PROJECT_DIR`, so it operates on
whatever repo the session is in.

## Requirements

The plugin shells out to `handoff`. It resolves, in order:

1. `HANDOFF_BIN` — absolute path to `bin/handoff.mjs`
2. a copy bundled at `plugin/bin/handoff.mjs`
3. `../../bin/handoff.mjs` — only in `--plugin-dir` development mode
4. `handoff` on `PATH`

If none resolve it prints an actionable message to **stderr** and exits 0. It
never writes to stdout (SessionStart and UserPromptSubmit read stdout as
injected context) and never fails your session.

## A note on `version`

`plugin.json` deliberately omits `version`. With a git-distributed plugin that
makes every commit a new version; pinning one would mean users get no updates
until it's manually bumped. `claude plugin validate` warns about this — the
warning is expected.
