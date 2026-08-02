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

Emits a tool-specific primer prompt to stdout. Pipe it, redirect it, or read it. `--tool` accepts `claude-code`, `claude-desktop`, `cursor`, `codex`, `gemini`, or `generic`. `--max-chars` caps the output length for tools with tight context budgets.

### `handoff install --tool <claude-code|claude-desktop|cursor>`

Prints the exact integration instructions for the named tool — the `.claude/settings.json` snippet for Claude Code, the Claude Desktop Project setup recipe (filesystem MCP + attached `.handoff/` files), or the `.cursorrules` additions for Cursor. Copy into place manually; `handoff` does not edit your tool configs.

### `handoff hook <session-start|user-prompt-submit|stop|pre-compact|rate-limit>`

Internal. Called by the Claude Code hook system. Do not invoke directly unless you're debugging the hook wiring. `stop` and `pre-compact` read Claude Code's JSON payload on stdin (including `transcript_path`) and, on top of refreshing the environment snapshot, **auto-capture** failed build/test attempts and user corrections straight from the session transcript — so `attempts.md` and `corrections.md` stay populated even when the agent forgets to log by hand. Auto-capture is best-effort and can never break a session; it dedupes via a per-session cursor plus content hashes stored in `.handoff/.capture-state.json`, tags entries with `**source:** auto`, and never writes decisions or a transcript.

### `handoff ingest --from <claude-code|cursor|codex|gemini|paste> [--session <id>] [--list] [--out <path>] [--project <path>]`

Reads past AI agent sessions and produces a structured markdown summary. Useful when you want to seed `.handoff/` from work you've already done in another tool.

- `--from claude-code` reads Claude Code JSONL transcripts directly.
- `--from cursor` reads Cursor's `state.vscdb` SQLite file (via built-in `node:sqlite`).
- `--from codex` reads Codex rollout JSONL files from `~/.codex/sessions/...`.
- `--from gemini` reads Gemini saved chats / checkpoints from `~/.gemini/tmp/...`.
- `--from paste` reads a transcript you've already copied out of a tool that has no on-disk logs (Claude Desktop, ChatGPT web, etc.). Exactly one of `--file <path>`, `--stdin`, or `--clipboard` must be supplied. The raw paste lands in `.handoff/transcript.md`; the rendered summary goes to `.handoff/ingested-context.md`.
- `--list` enumerates available sessions instead of ingesting.
- `--session <id>` picks a specific session; omit to use the most recent.
- `--out <path>` writes the summary to a file; omit for stdout.
- `--project <path>` scopes the search to a specific project root.

### `handoff capture [--from stdin|file] [--file <path>] [--mode full|summary] [--task <file>] [--decisions <file>] [--corrections <file>]`

AI-runnable end-of-session dump. An outgoing agent feeds its own transcript through `capture` right before the session closes, so the next agent sees the full history plus extracted markers.

- Appends the transcript to `.handoff/transcript.md` with a `## Session <ISO-date>` separator (safe to run twice).
- `--mode full` (default) additionally scans the transcript for `DECISION:` / `TODO:` / `CORRECTION:` / `TASK:` marker lines and appends each to the matching `.handoff/*.md` file. The AI structures its own output with markers; `capture` routes them.
- `--mode summary` only writes the transcript, skips extraction.
- `--task` / `--decisions` / `--corrections` override the default targets (useful in tests or for writing to alternate files).

```bash
# AI pipes its own final message through capture
echo "Session summary...
DECISION: switch to NURBS perforation via AddInnerProfile
CORRECTION: user said perforations go on folds too" | handoff capture --from stdin --mode full
```

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

Supported targets: `claude-code`, `claude-desktop`, `cursor`, `codex`, `gemini`, `generic`. For `claude-desktop` the launch step is always skipped (GUI app, no reliable CLI shim) — primer is copied, you open Claude Desktop and paste into the relevant Project yourself.

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

### `handoff verify [--check] [--file <path>] [--stdin]`

Checks whether a receiving agent actually picked up the handoff, instead of you finding out by being annoyed.

Run bare, it prints a restatement prompt: the agent restates the task, the constraints, what already failed, and what's still open. Run with `--check` and the agent's answer, it lists which recorded facts the restatement never mentioned.

```bash
handoff verify                              # print the prompt for the agent
handoff verify --check --file answer.md     # score the agent's restatement
```

**Read the misses, not the number.** Scoring is word overlap, not comprehension — verified adversarially. It cannot see that a restatement *contradicts* the source (negation is invisible), keyword-stuffed nonsense can score full marks, and a correct answer written in synonyms can score zero. That's why it never sets a failing exit code: it's a checklist, not a verdict.

### `handoff mcp [--cwd <path>]`

Runs an MCP (Model Context Protocol) server over stdio so any MCP-speaking agent — Codex, Cursor, Claude Desktop, Kimi Code, the ChatGPT app — can read and write handoff state natively, mid-conversation, without the clipboard round-trip. See [Integration recipe: MCP server](#integration-recipe-mcp-server) for the client config block. Project root comes from `--cwd`, else the `HANDOFF_PROJECT_ROOT` env var, else the current directory.
### `handoff evaluate [--strategy <name>] [--compare] [--sweep] [--json] [--k <n>] [--dir <path>]`

Developer tool that makes the relevance-ranking thresholds decidable by measurement instead of reasoning. It is a **deterministic retrieval eval**: over a set of labelled fixture scenarios (`tests/fixtures/eval/`), it asks whether the ranker surfaces the corrections/attempts a human marked relevant to each task, and reports precision, recall, F1, and MRR — no LLM, no API key, offline and reproducible.

```bash
handoff evaluate                 # score the shipping "recurrence" ranking, per scenario
handoff evaluate --compare       # recurrence vs a plain recency control, side by side
handoff evaluate --sweep         # sweep PROMOTION_THRESHOLD 2..6 and report F1 for each
handoff evaluate --json          # machine-readable output
```

The `recurrence` strategy calls the real `rankEntries` (the shipping code is the baseline, not a copy); `recency` is a last-N control. On the current corpus recurrence beats recency on every metric, and the sweep puts the shipped `PROMOTION_THRESHOLD = 3` on the optimal F1 plateau (raising it to 4+ discards genuine three-time themes).

**What it measures — and does not.** This is retrieval quality: did the right entries reach the top of the list. It does **not** measure agent behaviour, comprehension, or outcomes, and the shipping ranker is task-blind (it orders by recurrence and recency, never reading the task text). The output states this on every run. See `tests/fixtures/eval/README.md` for the label format.

## Staying current without discipline

`.handoff/` is only useful if it reflects reality, and relying on the agent to run `attempt`/`decide`/`correct` by hand does not hold up — in this repo's own history, 14 entries were logged across two days and then nothing for three and a half months across 13 commits. Three mechanisms close that gap:

- **Auto-capture.** The `Stop` and `PreCompact` hooks read the session transcript and log failed build/test attempts and user corrections themselves, tagged `**source:** auto`. Conservative by design (only `Bash` failures that look like real work; only short user messages that open with a correction cue), deduped by a per-session cursor plus content hashes, capped at 3 of each per session, and best-effort so it can never break a session.
- **Relevance ranking.** Corrections that recur across three or more entries are promoted to a condensed "Standing rules" block above the recent tail, so a rule you've repeated for months isn't pushed out by three fresh one-offs. Auto-captured entries need a higher bar (5) and a theme no human ever confirmed doesn't promote at all.
- **Mid-session re-injection.** SessionStart re-fires after a compaction (`source: "compact"`), so the full primer already returns then. The optional `UserPromptSubmit` hook covers ordinary drift *between* compactions by re-surfacing the standing rules only — and stays completely silent when nothing has recurred, so the common case costs nothing.

And `handoff doctor` now flags an artifact that has drifted out of sync: commits landing with no `handoff save`, a `task.md` naming a version behind `package.json`, or logs that have gone quiet across many commits. All advisory — staleness never changes the exit code.

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

Claude Code has the deepest integration — hooks in `.claude/settings.json` (the `PreCompact` block is optional):

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
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "handoff hook pre-compact" }
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
- `Stop` refreshes `environment.md` **and** auto-captures failed build/test attempts + user corrections from the session transcript, so `attempts.md` / `corrections.md` fill themselves in even when the agent forgets to log by hand. Auto-captured entries are tagged `**source:** auto` and deduped via `.handoff/.capture-state.json`.
- `PreCompact` (optional) runs the same auto-capture before Claude Code compacts the transcript, so nothing is lost to compaction.
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

## Integration recipe: MCP server

`handoff switch` and `handoff ingest` cover tools with on-disk session logs. For tools that store nothing readable (the ChatGPT app) or a format handoff has no ingest adapter for (Kimi Code), the clipboard primer used to be the only path. `handoff mcp` replaces that with a native one: a stdio [Model Context Protocol](https://modelcontextprotocol.io) server (JSON-RPC 2.0, protocol version `2025-06-18`) that any MCP-speaking agent can call mid-conversation. It is hand-rolled — no `@modelcontextprotocol/sdk`, no new dependency; `commander` is still the only runtime dependency.

It exposes six tools:

| Tool | Kind | Purpose |
| --- | --- | --- |
| `handoff_context` | read | The compact primer: task, open loops, standing corrections, recent failed attempts. |
| `handoff_open_loops` | read | The project's unfinished work. |
| `handoff_status` | read | Which `.handoff/` files are populated vs template, with sizes + snapshot time (staleness signal). |
| `handoff_log_correction` | write | Record that the user corrected the agent. |
| `handoff_log_attempt` | write | Record a failed approach so no future session repeats it. |
| `handoff_log_decision` | write | Record a decision and its reasoning. |

The server operates on one project root, taken from `--cwd`, else `HANDOFF_PROJECT_ROOT`, else the process working directory. Point it at the project you're handing off.

**Claude Desktop** — add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["-y", "@zohartito/handoff", "mcp"],
      "env": { "HANDOFF_PROJECT_ROOT": "/absolute/path/to/your/project" }
    }
  }
}
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.handoff]
command = "npx"
args = ["-y", "@zohartito/handoff", "mcp"]
env = { HANDOFF_PROJECT_ROOT = "/absolute/path/to/your/project" }
```

**Cursor** — add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "handoff": {
      "command": "npx",
      "args": ["-y", "@zohartito/handoff", "mcp", "--cwd", "/absolute/path/to/your/project"]
    }
  }
}
```

If `handoff` is installed globally (`npm i -g @zohartito/handoff`), replace `"command": "npx"` / `"args": ["-y", "@zohartito/handoff", "mcp", ...]` with `"command": "handoff"` / `"args": ["mcp", ...]`.

## Keyboard shortcuts and tray integration

Optional launchers live in `scripts/` (AutoHotkey v2 for Windows, AppleScript for macOS, XDG `.desktop` + shell wrapper for Linux) so you can trigger `handoff switch` from a global hotkey without opening a terminal first — see `scripts/README.md` for install and keybinding steps.

## Architecture

- **Local-first, file-based.** No cloud, no DB, no servers. The source of truth is `.handoff/` in your project root.
- **Per-project.** Each repo has its own `.handoff/`. Context does not leak across projects.
- **Integration layers per tool.** Claude Code uses hooks for zero-friction auto-inject. Cursor, Codex, and Gemini use `handoff switch` (clipboard plus launcher) until their extension stories mature.
- **Ingest parsers.** Claude Code transcripts are read directly from JSONL. Cursor state is read from `state.vscdb` via the built-in `node:sqlite` module — no native bindings, no extra dependencies.

## Roadmap

Everything through v7 has shipped (0.7.x): Claude Code auto-inject hooks, Claude Desktop primers, ingest adapters for Claude Code / Cursor / Codex / Gemini / paste, one-command `handoff switch`, agent-initiated handoffs, concurrency-safe writes, Obsidian sync, `search`/`patterns`/`capture`, and a CI matrix across ubuntu/macos/windows. `ROADMAP.md` is the authoritative per-version history (it doubles as the changelog) plus the adoption-gated future list (v8+).

## Known limitations

- Validated live on Windows and macOS (full CLI pass on real hardware; clipboard via `pbcopy` confirmed). Linux is covered by the CI test matrix but launcher/clipboard paths haven't run on a live Linux desktop — file issues if you hit one.
- Proactive rate-limit warning is not possible yet. Claude Code only fires `StopFailure` after the limit is hit. Blocked upstream.
- `handoff ingest --from cursor` requires Node 22+ for built-in `node:sqlite`. On Node 20 it exits with a clear error.

## Contributing

File a GitHub issue before opening a PR for anything beyond a bug fix. The file format is part of the contract — additions are welcome, breaking changes need discussion first. Keep the core dependency-free (commander is the only exception).

## License

MIT.
