# handoff — roadmap

Portable agent state across AI coding tools. This file is the single source of
truth for what's shipped, what's next, and what was explicitly cut.

---

## v0.1 — foundations (shipped)

Scaffolding, lifecycle commands, tool-agnostic primer.

- [x] `handoff init` — scaffold `.handoff/` in any project
- [x] `handoff status` — show what's populated
- [x] `handoff save` — refresh auto-collected state (git, env, versions)
- [x] `handoff attempt` — log a failed approach with its error trace
- [x] `handoff decide` — log a key decision with reasoning
- [x] `handoff correct` — log an agent mistake + the rule learned
- [x] `handoff prime --tool <tool>` — emit a tool-shaped primer
- [x] `handoff install --tool claude-code|cursor` — print integration recipe
- [x] Zero runtime deps beyond `commander`; Node 20+; Windows-first

---

## v1.0 — multi-tool ingest (in progress)

Read past sessions from every major coding tool and fold them back into
`.handoff/`.

- [x] `handoff ingest --from claude-code` — parse `~/.claude/projects/<enc>/*.jsonl`
- [x] `handoff ingest --from cursor` — parse `state.vscdb` via built-in `node:sqlite`
- [x] `handoff switch <tool>` — save + prime + clipboard + launch (v2.5 pulled in early)
- [x] `handoff doctor` — scan project + global install for common issues
- [x] `handoff uninstall --tool <tool>` — print removal instructions
- [x] Claude Code hooks (SessionStart / Stop / StopFailure with `rate_limit`) auto-inject the primer
- [x] Test suite: 17 tests across Claude Code + Cursor adapters, render parity, bug-injection validated
- [x] README.md (production, GitHub-ready)
- [ ] `handoff ingest --from codex` — parse `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- [ ] `handoff ingest --from gemini` — parse `~/.gemini/tmp/<hash>/chats/*.json` (+ JSONL follow-up)
- [ ] Round-trip cross-tool handoff test (start in tool A, hand off mid-task to tool B, confirm no re-explanation needed)
- [x] LICENSE (MIT)
- [x] Pick npm package name → `@zohartito/handoff` (scoped; unscoped names all squatted)
- [x] GitHub repo created at `github.com/zohartito/handoff`
- [ ] First push to GitHub
- [ ] `npm publish --access public`

---

## v1.5 — polish (next)

Round off the rough edges once v1.0 ships.

- [ ] `handoff ingest --all` — ingest every recent session across every tool for this project
- [ ] Compact primer mode (< 2k chars for clipboard-limited tools)
- [ ] `handoff prime --tool codex|gemini` (generic works today; tool-tuned primers are nicer)
- [ ] Schema migration: bump `meta.json` schemaVersion and auto-migrate v1 → v2 on load
- [ ] mac + linux validation pass (Windows-first today; no known blockers, just untested)
- [ ] `.handoff/corrections.md` template includes a starter "don't re-explain the project" rule

---

## v2 — Cursor MCP server (CUT)

Originally planned: expose `.handoff/` as an MCP server so Cursor agents could
read/write handoff state natively instead of via files.

**Cut because** `handoff switch` + `handoff ingest --from cursor` already give
Cursor a no-friction path via SQLite + clipboard. MCP would add a moving part
and a second surface area for bugs without unlocking a real capability the
file-based path lacks. Revisit only if Cursor's file-based workflow genuinely
falls short.

---

## v2.5 — one-button handoff (shipped early)

Originally slated after v2. Pulled forward because the ingest work made it
trivial.

- [x] `handoff switch <tool>` does save + prime + clipboard + launch
- [ ] System-tray app / keyboard shortcut → same behavior without a terminal
  *(deferred; CLI + `handoff switch` covers the 90% case today)*

---

## v3 — agent-initiated handoffs (planned)

The real unlock: the agent itself decides it's time to hand off, not the user.

- [ ] Primer detects "I'm about to hit rate limits" / "I should switch tools" signals
- [ ] Slash command inside an agent session that triggers `handoff switch`
  without leaving the session
- [ ] Claude Code "subagent" primer variant so a spawned task agent inherits
  `.handoff/` context
- [ ] Multi-agent coordination: two tools working on the same `.handoff/`
  concurrently without clobbering each other (file locking or JSONL append
  semantics)

---

## v4 — permanent memory (planned)

Right now `.handoff/` is per-project and ephemeral. v4 is "you never lose
context across projects either."

- [ ] Obsidian vault integration — every session summary lands as a daily
  note, every decision a Decisions/ entry, every correction a rule
- [ ] `handoff search "<query>"` across all projects' `.handoff/`
- [ ] Auto-extract cross-project patterns ("this user prefers X in language Y")

---

## Explicitly not doing

- Binary database format for `.handoff/`. It stays human-readable
  markdown + JSON/JSONL so the user can inspect, edit, and version-control it.
- Vendor lock-in to one coding tool. The shared files contain no
  Claude-specific or Cursor-specific idioms — tool-shaped output only happens
  at primer-generation time.
- A web service or cloud sync. `.handoff/` travels with the project via
  normal git; that's the whole point.
- An agent-side runtime dependency. `.handoff/` is plain files; any tool
  (including ones that don't exist yet) can read them.
