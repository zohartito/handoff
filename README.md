# handoff

**When you switch AI coding tools mid-task, the next tool doesn't know what the last one was doing. `handoff` fixes that.**

You're deep in a task in Claude Code. You hit the 5-hour rate limit. You open Cursor. Ten minutes of re-pasting context later, the new agent repeats a mistake the old one already made an hour ago.

`handoff` keeps a small `.handoff/` folder in your project — plain markdown and JSON, no cloud, no database — and every tool reads and writes it as you work. Switch tools and the next one picks up exactly where the last left off.

```
  Claude Code    Claude Desktop    Cursor    Codex    Gemini
       \_____________  |  ___________|_________/______/
                     \_|_/
                 .handoff/
             (shared project state)
```

Works with: Claude Code, Claude Desktop, Cursor, Codex, Gemini. Tested daily on Windows; Mac/Linux paths wired but use at your own risk.

---

## Install

```bash
npm install -g @zohartito/handoff
```

Requires Node 22.5+ (the Cursor adapter uses the built-in `node:sqlite`, stabilised in 22.5). No runtime deps beyond `commander`.

Verify:

```bash
handoff --version   # 0.7.1
```

---

## 30-second quickstart

```bash
cd my-project
handoff init
```

That's it — `.handoff/` is scaffolded. Now just work. When you need to switch tools:

```bash
handoff switch cursor
```

State is saved, a primer is on your clipboard, Cursor is launching. Paste the primer as your first message.

---

## Tool-by-tool setup

One-time setup per tool. After this, you never think about it again.

### Claude Code (zero-friction — hooks auto-inject)

```bash
handoff install --tool claude-code
```

Prints the 3-hook snippet to paste into `~/.claude/settings.json`. Once in place:

- `SessionStart` automatically primes every new session with `.handoff/` contents
- `Stop` auto-refreshes `environment.md`
- `StopFailure` (with the `rate_limit` matcher) logs rate-limit hits

You don't run any `handoff` commands by hand for Claude Code — the agent does.

### Claude Desktop (paste-based — no on-disk transcript)

Claude Desktop stores conversations in the cloud, so there's no file for `handoff` to read. Instead:

```bash
handoff install --tool claude-desktop
```

This prints a recipe for Desktop's Projects feature: attach `.handoff/` via filesystem MCP, paste a primer into Project instructions. At session end, ask Desktop-Claude to dump the conversation into `.handoff/transcript.md` and update the log files.

If the conversation already happened and you just want to capture it:

```bash
# copy the conversation to clipboard in Desktop, then:
handoff ingest --from paste --clipboard
```

The summary lands in `.handoff/ingested-context.md` and the raw transcript in `.handoff/transcript.md`.

### Cursor

```bash
handoff install --tool cursor
```

Prints the `.cursorrules` block to add. Whenever you need state from a previous tool:

```bash
handoff switch cursor
```

Saves state, builds a primer, copies to clipboard, launches Cursor. Paste and go.

### Codex / Gemini

No install step required (no equivalent of Claude Code hooks yet). Just:

```bash
handoff switch codex     # or: handoff switch gemini
```

Same pattern: save, prime, copy, launch.

---

## Daily flow — what to log as you work

The `.handoff/` folder is only useful if it's kept current. Four commands cover ~everything:

```bash
handoff decide "use zod for validation" \
  --because "already a dep via trpc"

handoff attempt "batch migration at 1000/sec" \
  --error "connection pool exhausted" \
  --fix "batch at 100"

handoff correct "was adding new ORM" \
  --user-said "no new deps — use the raw pg client"

handoff save   # refresh git/env snapshot
```

Put a reminder in your `CLAUDE.md` / `.cursorrules` (the `install` command output already includes this snippet) and the agent will log on its own.

### End-of-session dump (AI-runnable)

When a Desktop/Claude-Code session ends, have the agent pipe a summary through `handoff capture`:

```
Session summary in 3 lines.
DECISION: switched to NURBS perforation via AddInnerProfile
TODO: test with 200+ holes on the south facade
CORRECTION: user said perforations go on folds too, not just flats
```

```bash
echo "<that summary>" | handoff capture --from stdin
```

- Appends to `.handoff/transcript.md` with a dated separator (safe to run twice)
- Extracts every `DECISION:` / `TODO:` / `CORRECTION:` / `TASK:` line into the matching `.handoff/*.md` file

Result: next session sees the full history plus routed markers in the right log files.

---

## Ingesting past work

Seed `.handoff/` from conversations you already had:

```bash
handoff ingest --from claude-code              # ~/.claude JSONL
handoff ingest --from cursor                   # Cursor's SQLite state
handoff ingest --from codex                    # ~/.codex rollouts
handoff ingest --from gemini                   # ~/.gemini tmp dir
handoff ingest --from paste --file chat.md     # anything else (Desktop, ChatGPT, etc.)
handoff ingest --from paste --stdin            # pipe in
handoff ingest --from paste --clipboard        # read from system clipboard
handoff ingest --all                           # everything, concatenated
handoff ingest --from claude-code --list       # enumerate sessions without ingesting
```

Each mode writes a rendered summary to `.handoff/ingested-context.md` (and the raw paste to `.handoff/transcript.md` for `--from paste`). Future `handoff prime` / `handoff switch` runs surface that context automatically.

---

## `.handoff/` folder layout

```
.handoff/
  HANDOFF.md          # index / readme for the folder itself
  task.md             # what we're trying to do
  progress.md         # what's done, what's next
  decisions.md        # what was decided and why
  attempts.md         # what was tried that didn't work
  corrections.md      # what the user pushed back on
  identity.md         # who the user is, preferences, style
  environment.md      # os, node, git, cwd — refreshed on save
  codebase-map.md     # key files, entry points, module layout
  open-loops.md       # unresolved questions, TODOs for next session
  references.md       # links, docs, issue numbers
  ingested-context.md # summary of any ingested past session
  transcript.md       # raw ingested/captured transcript history
  meta.json           # schema version, source tool, timestamps
  files.json          # manifest
```

Human-readable, portable (copy the folder, keep the context), tool-agnostic (no tool-specific idioms in the files — that happens at primer-generation time).

---

## Command reference

`handoff <command> --help` prints full options. Quick list:

| Command | Does |
|---------|------|
| `handoff init [--from <tool>] [--force]` | Scaffold `.handoff/` in the current dir |
| `handoff status` | Show which files are populated vs template |
| `handoff save` | Refresh env snapshot (os/node/git) |
| `handoff decide <choice> --because <reason>` | Log a decision |
| `handoff attempt <what> --error <trace>` | Log a failed approach |
| `handoff correct <action> --user-said <quote>` | Log a user correction |
| `handoff capture --from <stdin\|file>` | End-of-session transcript dump + marker extraction |
| `handoff ingest --from <source>` | Read past sessions from a tool's native storage |
| `handoff prime --tool <tool>` | Emit a tool-shaped primer to stdout |
| `handoff switch <tool>` | Save + prime + clipboard + launch |
| `handoff install --tool <tool>` | Print integration recipe for a tool |
| `handoff uninstall --tool <tool>` | Print removal recipe |
| `handoff doctor` | Scan for common install/state issues |
| `handoff obsidian sync` | Mirror `.handoff/` into an Obsidian vault |
| `handoff search <query>` | Grep every `.handoff/` on this machine |
| `handoff patterns` | Cross-project theme report (correction themes, tool usage) |

Supported tool IDs everywhere: `claude-code`, `claude-desktop`, `cursor`, `codex`, `gemini`, `generic`.

---

## Advanced

### Obsidian sync (cross-project memory)

```bash
export HANDOFF_OBSIDIAN_VAULT=/path/to/vault
handoff obsidian sync
```

Writes:
- `Daily/YYYY-MM-DD.md` — one block per run
- `Decisions/YYYY-MM-DD_<project>_<slug>.md` — one note per decision
- `Rules/<project>__<slug>.md` — one note per correction

Session state becomes permanent searchable memory across every project you work on.

### Search across everything

```bash
handoff search "nurbs perforation"
```

Greps every `.handoff/` on the machine. Ranked: exact-word > project recency > file order. Override search roots with `--root` (repeatable) or `HANDOFF_SEARCH_ROOTS` env var.

### Pattern detection

```bash
handoff patterns --top 20
```

Aggregates correction themes, failure modes, and per-tool usage counts across every `.handoff/` on the machine. Useful for spotting mistakes you keep making your agents undo.

### Hotkeys

`scripts/` has optional global-hotkey launchers: AutoHotkey v2 (Windows), AppleScript (macOS), `.desktop` + shell wrapper (Linux). Bind a hotkey to `handoff switch cursor` and never open a terminal to tool-swap again. See `scripts/README.md`.

---

## Architecture (brief)

- **Local-first, file-based.** Source of truth is `.handoff/` in your project. No cloud, no DB, no servers.
- **Per-project.** Each repo owns its own `.handoff/`. No cross-project leaks.
- **Tool integrations.** Claude Code uses hooks for auto-inject. Desktop uses Projects + filesystem MCP. Cursor/Codex/Gemini use `handoff switch` (clipboard + launcher) until they expose better extension points.
- **Ingest parsers are native.** Claude Code → JSONL parsing. Cursor → `state.vscdb` via built-in `node:sqlite`. Codex → `~/.codex/sessions` rollouts. Gemini → `~/.gemini/tmp` chats. Paste → anything else.
- **Zero runtime deps** beyond `commander`. No native bindings.

---

## Known limitations

- Only tested heavily on Windows. Mac/Linux paths are in the code but unvalidated — file an issue if one breaks.
- Proactive rate-limit warning isn't possible yet — Claude Code's `StopFailure` only fires *after* the limit. Tracked upstream.
- Schema migrations are placeholder. If `meta.json`'s schema version changes across an upgrade, you may need `handoff init --force` and re-seed.

---

## Contributing

File a GitHub issue before opening a PR for anything beyond a bug fix. The file format is part of the contract — additions welcome, breaking changes need discussion first. Keep the core dep-free (commander is the only exception).

See `ROADMAP.md` for what's shipped, what's next, and what was explicitly cut.

## License

MIT.
