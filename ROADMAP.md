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

## v1.0 — multi-tool ingest (shipped)

Read past sessions from every major coding tool and fold them back into
`.handoff/`.

- [x] `handoff ingest --from claude-code` — parse `~/.claude/projects/<enc>/*.jsonl`
- [x] `handoff ingest --from cursor` — parse `state.vscdb` via built-in `node:sqlite`
- [x] `handoff switch <tool>` — save + prime + clipboard + launch (v2.5 pulled in early)
- [x] `handoff doctor` — scan project + global install for common issues
- [x] `handoff uninstall --tool <tool>` — print removal instructions
- [x] Claude Code hooks (SessionStart / Stop / StopFailure with `rate_limit`) auto-inject the primer
- [x] Test suite: 74 tests across all 4 adapters, render parity, schema migration, compact primer, cross-platform, bug-injection validated
- [x] README.md (production, GitHub-ready)
- [x] `handoff ingest --from codex` — parse `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- [x] `handoff ingest --from gemini` — parse `~/.gemini/tmp/<hash>/chats/*.json` (+ JSONL follow-up)
- [x] Round-trip cross-tool handoff test — Codex-validated end-to-end; all 4 primers 4/4; caught one ingest scoping bug that shipped as a 0.1.1 fix
- [x] LICENSE (MIT)
- [x] Pick npm package name → `@zohartito/handoff` (scoped; unscoped names all squatted)
- [x] GitHub repo created at `github.com/zohartito/handoff`
- [x] First push to GitHub
- [x] `npm publish --access public` — `@zohartito/handoff@0.1.0` → `0.1.1` (ingest-scoping fix) → `0.2.0` (v1.5) live

---

## v1.5 — polish (shipped, 0.2.0)

- [x] `handoff ingest --all` — orchestrator across all 4 sources with graceful per-source fallback
- [x] Compact primer mode — `--compact` keeps task + open loops + latest 3 corrections + latest 3 attempts + 1-line env (< 2k chars typical)
- [x] Tool-tuned primers for codex + gemini — include per-tool tool-name mappings and framing
- [x] Schema migration framework (`src/format/migrate.ts`) — `loadMeta` auto-migrates, warns on future versions, safe on corrupt JSON; `CURRENT_SCHEMA_VERSION` still 1, but the hooks are in
- [x] Cross-platform audit — fixed Cursor user dir (%APPDATA%/Library/Application Support/XDG), linux clipboard cascade (wl-copy → xclip → xsel), platform-conditional case sensitivity for `cwdMatchesProject`; see `CROSS-PLATFORM.md` for what still needs live mac/linux validation
- [x] `.handoff/corrections.md` template seeded with the "don't re-explain the project" rule

---

## v1.6 — loose ends (small, do when convenient)

Tiny follow-ups caught during v1.5 ship. None block v3; all low-effort.

- [x] Suppress `Source tool: unknown` in primers when `sourceTool` is unset (init without `--from`)
- [ ] Live mac + linux validation pass — code audit is done (see `CROSS-PLATFORM.md`), but "Requires live testing" items need a real mac/linux box. Specifically: clipboard cascade (wl-copy/xclip/xsel), launcher PATH resolution on snap/flatpak, Cursor FS layout on non-Windows, Claude Code project-path encoding under Unix roots.
- [x] System-tray / keyboard-shortcut variant of `handoff switch` — covered by the optional launchers in `scripts/` (AutoHotkey / AppleScript / XDG `.desktop` + shell wrapper). See `scripts/README.md`.
- [x] Document the "blocked upstream" pre-rate-limit API gap as an explicit roadmap line — see note on v3 item 1 below.

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

## v2.5 — one-button handoff (shipped, 0.3.0)

Originally slated after v2. Pulled forward because the ingest work made it
trivial.

- [x] `handoff switch <tool>` does save + prime + clipboard + launch
- [x] System-tray app / keyboard shortcut → same behavior without a terminal.
  Shipped as optional launchers in `scripts/` (AutoHotkey v2 on Windows,
  AppleScript on macOS, XDG `.desktop` + `handoff-switch.sh` on Linux).

---

## v3 — agent-initiated handoffs (shipped, 0.3.0)

The real unlock: the agent itself decides it's time to hand off, not the user.

- [x] Primer detects "I'm about to hit rate limits" / "I should switch tools" signals.
  **Upstream gap (blocked):** Claude Code only fires `StopFailure` *after* the
  rate limit is hit; no pre-rate-limit event exists in the hook surface today.
  Until upstream exposes one, the primer's rate-limit protocol is agent-driven
  (the agent self-reports when it thinks it's close), not event-driven.
- [x] Slash command inside an agent session that triggers `handoff switch`
  without leaving the session — `templates/claude-commands/handoff-switch.md`
  for Claude Code, `templates/cursor/slash-handoff-switch.md` for Cursor.
  `handoff install` points users at the template paths.
- [x] Claude Code "subagent" primer variant so a spawned task agent inherits
  `.handoff/` context
- [x] Multi-agent coordination: two tools working on the same `.handoff/`
  concurrently without clobbering each other — `withFileLock` in
  `src/util/lock.ts` wraps the markdown append/RMW paths in
  attempt/decide/correct/save; JSONL writers use pure `fs.appendFile`
  (single-syscall atomic for small payloads).

---

## v4 — permanent memory (shipped, 0.4.0)

Right now `.handoff/` is per-project and ephemeral. v4 is "you never lose
context across projects either."

- [x] Obsidian vault integration — `handoff obsidian sync` writes the current
  project's `.handoff/` into an Obsidian vault as `Daily/YYYY-MM-DD.md`
  (append-if-new-block), `Decisions/YYYY-MM-DD_<project>_<slug>.md` (one per
  decision entry), and `Rules/<project>__<slug>.md` (one per correction,
  append-only rulebook). Vault resolved via `--vault` or
  `HANDOFF_OBSIDIAN_VAULT`.
- [x] `handoff search "<query>"` scans every `.handoff/` folder on the
  machine (default roots: home + common code dirs; override via `--root` or
  `HANDOFF_SEARCH_ROOTS`). Ranks exact-word > recency > file order.
- [x] Cross-project patterns: `handoff patterns` aggregates correction-themes
  and failure-modes (unigram + bigram frequency, stopwords filtered) across
  every `.handoff/` and tags each theme with the languages it appeared in
  (python/node/rust/go/ruby/php/unknown via project-root file detection).
  Also reports tool-usage counts across projects.

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
