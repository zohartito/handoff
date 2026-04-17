# handoff

Portable session-state CLI for AI coding tools. When you switch mid-task between Claude Code, Cursor, Codex, or Gemini (usually because you hit a rate limit), `handoff` gives the next tool the same context the last tool had: what was tried, what failed, what was decided, what you corrected.

No cloud. No database. No servers. Just a `.handoff/` folder of markdown and JSON files in your project root.

## The problem

You're deep in a task. Claude Code hits its 5-hour limit. You open Cursor. You now spend 10 minutes re-explaining the task, the constraints, what you already tried, what the agent got wrong last time. Half of it you forget to mention. The new tool repeats the same mistakes.

## What handoff does

`handoff init` drops a `.handoff/` folder in your project. Your AI tool reads and writes structured files there as it works (task, progress, decisions, attempts, corrections, environment, references). When you switch tools, the next one reads the same folder and picks up where the last left off.

For Claude Code this is zero-friction (hooks auto-inject on session start, auto-refresh on stop). For Cursor/Codex/Gemini you run `handoff switch <tool>` — it saves state, builds a primer, copies it to your clipboard, and launches the target tool in the current directory. Paste and go.

## Quick start

```bash
cd my-project
handoff init
```

Work normally in Claude Code — it hydrates from `.handoff/` on session start and logs as it goes.

Hit a rate limit? Switch tools:

```bash
handoff switch cursor
```

State is saved, primer is on your clipboard, Cursor is launching. Paste the primer as your first message.

## Installation

Requires Node 22.5+ (the Cursor ingest adapter uses the built-in `node:sqlite` module, which stabilised in 22.5). No other runtime dependencies beyond `commander`.

```bash
npm install -g @zohartito/handoff
```

Or install from source as a fallback:

```bash
git clone https://github.com/zohartito/handoff.git
cd handoff
npm install
npm run build
npm link
```

## Commands

Run `handoff <command> --help` for full options on any command.

### `handoff init [--from <tool>] [--force]`

Scaffolds `.handoff/` in the current directory. `--from <tool>` seeds identity/environment from a known tool context. `--force` overwrites an existing folder.

### `handoff status`

Shows which files in `.handoff/` are filled vs still template. Filled files show `●`, template files show `○`. Quick signal for whether the current session has captured anything meaningful yet.

### `handoff save`

Refreshes the environment snapshot in `environment.md` — os, user, node version, cwd, git branch and head. Called automatically by the Claude Code Stop hook; run manually before a cross-tool switch if you skipped the hook.

### `handoff attempt <what> [--error <trace>] [--fix <desc>] [--summary <text>]`

Logs a failed approach to `attempts.md` and `transcript.jsonl`. Use this the moment you know an approach didn't pan out — the next tool needs to know not to retry it.

```bash
handoff attempt "run migration with --force" \
  --error "connection pool exhausted at step 3" \
  --fix "batch in groups of 100" \
  --summary "bulk write hits pg pool limit"
```

### `handoff decide <choice> [--because <reason>] [--alt <alternatives...>]`

Logs a design decision to `decisions.md`. Capture the decision, the reasoning, and the alternatives you rejected so the next session doesn't re-litigate it.

```bash
handoff decide "use zod for request validation" \
  --because "already a dep via trpc, team knows it" \
  --alt "joi" "yup" "hand-rolled"
```

### `handoff correct <action> --user-said <text> [--lesson <text>]`

Logs a user correction to `corrections.md`. When the user pushes back on an approach, log it verbatim — the lesson travels with the project.

```bash
handoff correct "was about to add a new ORM layer" \
  --user-said "no new deps, use the raw pg client that's already wired up" \
  --lesson "this project values minimal deps over abstraction"
```

### `handoff prime [--tool <tool>] [--max-chars <n>]`

Emits a tool-specific primer prompt to stdout. Pipe it, redirect it, or read it. `--tool` accepts `claude-code`, `cursor`, `codex`, `gemini`, or `generic`. `--max-chars` caps the output length for tools with tight context budgets.

### `handoff install --tool <claude-code|cursor>`

Prints the exact integration instructions for the named tool — the `.claude/settings.json` snippet for Claude Code, or the `.cursorrules` additions for Cursor. Copy into place manually; `handoff` does not edit your tool configs.

### `handoff hook <session-start|stop|rate-limit>`

Internal. Called by the Claude Code hook system. Do not invoke directly unless you're debugging the hook wiring.

### `handoff ingest --from <claude-code|cursor|codex|gemini> [--session <id>] [--list] [--out <path>] [--project <path>]`

Reads past AI agent sessions and produces a structured markdown summary. Useful when you want to seed `.handoff/` from work you've already done in another tool.

- `--from claude-code` reads Claude Code JSONL transcripts directly.
- `--from cursor` reads Cursor's `state.vscdb` SQLite file (via built-in `node:sqlite`).
- `--from codex` reads Codex rollout JSONL files from `~/.codex/sessions/...`.
- `--from gemini` reads Gemini saved chats / checkpoints from `~/.gemini/tmp/...`.
- `--list` enumerates available sessions instead of ingesting.
- `--session <id>` picks a specific session; omit to use the most recent.
- `--out <path>` writes the summary to a file; omit for stdout.
- `--project <path>` scopes the search to a specific project root.

If the current project already has a `.handoff/` folder and you omit `--out`,
the summary is also persisted to `.handoff/ingested-context.md`. Future
`handoff prime` / `handoff switch` calls automatically surface that imported
context, so the next tool sees the past transcript even before you've manually
folded it into `task.md`, `progress.md`, etc.

### `handoff switch <tool> [--no-save] [--no-launch]`

One-shot handoff. Saves current state, builds a tool-specific primer, copies it to the clipboard, and launches the target tool in the current working directory.

- For `claude-code`, the clipboard step is skipped — the SessionStart hook injects the primer automatically.
- `--no-save` skips the env refresh.
- `--no-launch` copies the primer to the clipboard but does not spawn the tool. Useful if the target tool is already open.

Supported targets: `claude-code`, `cursor`, `codex`, `gemini`, `generic`.

### `handoff obsidian sync [--vault <path>] [--project <path>]`

Writes the current project's `.handoff/` content into an Obsidian vault so your session state survives as permanent cross-project memory. Produces:

- `Daily/YYYY-MM-DD.md` — appends one `## handoff: <project> — HH:MM` block per run (idempotent within the same minute).
- `Decisions/YYYY-MM-DD_<project>_<slug>.md` — one note per decision entry; updates in place if the entry body changes.
- `Rules/<project>__<slug>.md` — one note per correction (append-only rulebook).

Vault resolution: `--vault` wins over `HANDOFF_OBSIDIAN_VAULT`. No vault configured → error.

### `handoff search <query> [--limit <n>] [--root <path>...] [--case-sensitive]`

Greps every `.handoff/` folder on the machine for `<query>` and returns ranked results grouped by project. Default roots: `$HOME` plus common code dirs (`~/code`, `~/repos`, `~/dev`, `~/projects`, `~/src`, `~/work`, `~/Documents/GitHub`). Override with `--root` (repeatable) or `HANDOFF_SEARCH_ROOTS` (colon/semicolon separated). Ranking: exact-word > project recency > file order.

### `handoff patterns [--top <n>] [--root <path>...]`

Aggregates correction themes, failure modes, and tool usage across every `.handoff/` on the machine. Uses the same discovery roots as `search`. Tokenizes corrections/attempts (unigrams + bigrams, stopwords filtered), tags each theme with the project languages it appeared in, and reports tool-usage counts. Useful for spotting recurring mistakes you keep correcting LLMs about.

## File format

A `.handoff/` directory looks like this:

```
.handoff/
  HANDOFF.md          # index / readme for the folder itself
  task.md             # what we're trying to do
  progress.md         # what's done, what's next
  decisions.md        # what we decided and why
  attempts.md         # what we tried that didn't work
  corrections.md      # what the user pushed back on
  identity.md         # who the user is, preferences, style
  environment.md      # os, node, git, cwd — refreshed on save
  codebase-map.md     # key files, entry points, module layout
  open-loops.md       # unresolved questions, TODOs for next session
  references.md       # links, docs, issue numbers
  meta.json           # schema version, source tool, timestamps, project root
  files.json          # manifest of the above
  tool-history.jsonl  # append-only per-tool event log
  transcript.jsonl    # append-only narrative log
```

**Format constraints:**

- Human-readable markdown plus JSON/JSONL. No binary databases.
- Portable — copy the folder, keep the context. Commit it, zip it, rsync it.
- Tool-agnostic. Shared files contain no Claude-specific idioms. Tool-specific framing happens at primer-generation time.

## Integration recipe: Claude Code

Claude Code has the deepest integration — three hooks in `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "handoff hook session-start" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "handoff hook stop" }
        ]
      }
    ],
    "StopFailure": [
      {
        "matcher": "rate_limit",
        "hooks": [
          { "type": "command", "command": "handoff hook rate-limit" }
        ]
      }
    ]
  }
}
```

- `SessionStart` injects the primer automatically — no paste required.
- `Stop` refreshes `environment.md` so the next tool sees the latest state.
- `StopFailure` with the `rate_limit` matcher logs the event and prints a swap-tool nudge.

**Important:** `StopFailure` is reactive. Claude Code does not currently expose a pre-rate-limit API, so `handoff` cannot warn you before you hit the wall — only after. This is tracked in `ROADMAP.md` under Research.

**Also:** add a section to your `CLAUDE.md` instructing the agent to log as it works:

```markdown
## handoff logging

Log meaningful events as you work:
- `handoff attempt <what> --error <trace>` when an approach fails
- `handoff decide <choice> --because <reason>` when you pick an approach
- `handoff correct <action> --user-said <quote>` when the user pushes back

These keep the `.handoff/` folder current so the next tool has full context.
```

## Integration recipe: Cursor

Cursor does not yet have a stable hook or MCP surface for this. Until it does:

```bash
handoff switch cursor
```

This saves state, builds the primer, copies it to your clipboard, and launches Cursor in the current directory. Paste the primer as your first message.

Add a handoff-awareness section to `.cursorrules`:

```
# handoff

This project uses `handoff` for cross-tool session state. A `.handoff/`
folder in the project root contains task, progress, decisions, attempts,
and corrections as markdown.

Read `.handoff/HANDOFF.md` at the start of each session.
Log significant events with `handoff attempt`, `handoff decide`, and
`handoff correct` as you work.
```

Codex and Gemini follow the same pattern: `handoff switch codex`, `handoff switch gemini`. Native integrations will land as those tools expose suitable extension points.

## Keyboard shortcuts and tray integration

Optional launchers live in `scripts/` (AutoHotkey v2 for Windows, AppleScript for macOS, XDG `.desktop` + shell wrapper for Linux) so you can trigger `handoff switch` from a global hotkey without opening a terminal first — see `scripts/README.md` for install and keybinding steps.

## Architecture

- **Local-first, file-based.** No cloud, no DB, no servers. The source of truth is `.handoff/` in your project root.
- **Per-project.** Each repo has its own `.handoff/`. Context does not leak across projects.
- **Integration layers per tool.** Claude Code uses hooks for zero-friction auto-inject. Cursor, Codex, and Gemini use `handoff switch` (clipboard plus launcher) until their extension stories mature.
- **Ingest parsers.** Claude Code transcripts are read directly from JSONL. Cursor state is read from `state.vscdb` via the built-in `node:sqlite` module — no native bindings, no extra dependencies.

## Roadmap

v1.0 ships with Claude Code auto-inject, Cursor via switch, and ingest for both. See `ROADMAP.md` for the full v1 through v4 plan: engineering hygiene (tests, `handoff doctor`, `handoff uninstall`), more adapters (Codex, Gemini), native integrations as MCP and hook APIs mature, a tray app, agent-initiated handoffs, and an Obsidian archive target.

## Known limitations

- Only tested on Windows so far. Mac and Linux clipboard and launcher paths are in the code but unvalidated — file issues if you hit one.
- Proactive rate-limit warning is not possible yet. Claude Code only fires `StopFailure` after the limit is hit. Blocked upstream.
- Schema migration logic is a placeholder. If the schema version in `meta.json` changes across a `handoff` upgrade, you may need to `handoff init --force` and re-seed.
- `handoff ingest --from cursor` requires Node 22+ for built-in `node:sqlite`. On Node 20 it exits with a clear error.

## Contributing

File a GitHub issue before opening a PR for anything beyond a bug fix. The file format is part of the contract — additions are welcome, breaking changes need discussion first. Keep the core dependency-free (commander is the only exception).

## License

MIT.
