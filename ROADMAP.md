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
- [x] Zero runtime deps beyond `commander`; Node 22.5+; Windows-first

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
- [x] Test suite: 113 tests across all 4 adapters, render parity, schema migration, compact primer, cross-platform, bug-injection validated
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
- [x] Live mac validation pass — all 6 items green on real macOS hardware via Synology sync dogfood (2026-04-17). Install + version, pbcopy clipboard cascade, launcher PATH resolution (codex/cursor/code), Cursor FS layout under `~/Library/Application Support/`, Claude Code encoder under Unix roots, Obsidian sync on Synology-mounted vault. Linux validated via CI matrix (`.github/workflows/ci.yml`, ubuntu-latest).
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

## v5 — hardening (shipped, 0.5.0)

Cross-platform + cross-node validation before the adapter surface kept growing.

- [x] Live macOS validation pass — install + version, `pbcopy` clipboard cascade, launcher PATH resolution, Cursor FS layout under `~/Library/Application Support/`, Claude Code encoder under Unix roots, Obsidian sync on Synology-mounted vault
- [x] CI matrix — `ubuntu-latest × macos-latest × windows-latest` × Node 22 + 24 via `.github/workflows/ci.yml`
- [x] Engines bump — `"node": ">=22.5"` in `package.json`; `node:sqlite` stabilised in 22.5 so we stopped shipping the "Node 20 works except for the Cursor adapter" caveat
- [x] `scripts/run-tests.mjs` cross-version test runner — shells into every `test/*.test.mjs`, aggregates results, returns non-zero on any failure (so CI fails fast without each suite reimplementing the wrapper)
- [x] `HANDOFF_SEARCH_ROOTS` Windows path-delimiter fix — `path.delimiter` (`;` on Windows, `:` on POSIX) instead of hard-coded `:`, in both `src/search.ts` and `src/patterns.ts`

---

## v6 — ingest persistence (shipped, 0.6.0)

The Codex-dogfood fix. Imported transcripts used to evaporate the moment you ran `handoff prime` from a second agent; now they stick.

- [x] `handoff ingest --from <tool>` persists the parsed summary to `.handoff/ingested-context.md` whenever the project has a `.handoff/` folder. Previous runs are superseded, not appended, so the file always reflects the most-recent ingest
- [x] `handoff prime` surfaces `ingested-context.md` in both full and `--compact` modes, so the next agent sees the handed-over context without the human re-pasting
- [x] Round-trip validated end-to-end via a Codex-autonomous session — Codex ingested a Claude Code transcript, ran `handoff prime` in its own session, and answered follow-up questions from the imported context with no human glue. This was the first "agent hands off to agent without a human in the loop" moment
- [x] 37 → 113 tests (new coverage: ingest persistence, ingested-context surfacing in prime, compact-mode truncation of ingested content, cross-adapter persistence parity, supersede-not-append behaviour)

---

## v7 — Claude Desktop + paste ingest (shipped, 0.7.0)

Dogfooded into existence: a Claude Desktop conversation with no on-disk transcript has no ingest path, so the handoff ritual falls apart at the Desktop boundary. v7 makes Desktop a first-class target.

- [x] `handoff ingest --from paste` — new adapter accepting a pasted transcript via `--file <path>`, `--stdin`, or `--clipboard`. Writes the raw paste to `.handoff/transcript.md` and produces a `renderMarkdown`-shaped summary via the standard `emitOutput` path, so pasted transcripts land in `.handoff/ingested-context.md` with the same shape as every other adapter. `--all` composes it alongside the other sources.
- [x] `handoff capture` — AI-runnable end-of-session dump. Reads a transcript from stdin or file, appends to `.handoff/transcript.md` with timestamped session separators, and (in `--mode full`) heuristic-extracts `DECISION:` / `TODO:` / `CORRECTION:` / `TASK:` marker lines into the matching log files. Append-safe across multiple runs; `--mode summary` skips extraction.
- [x] `handoff prime --tool claude-desktop` — Desktop-flavoured primer. References filesystem MCP (not shell), tells Desktop-Claude to read every `.handoff/` file on session start and dump `.handoff/transcript.md` + update the logs at session end. Respects `--compact` and `--subagent` variants. Rate-limit section suggests switching to claude-code as the same-account fallback.
- [x] `handoff install --tool claude-desktop` / `uninstall --tool claude-desktop` — manual setup recipe for the Desktop Projects feature + filesystem/Obsidian MCP paths. No hook system on Desktop, so the integration is paste-primer-into-Project-instructions.
- [x] `handoff switch claude-desktop` — force-`noLaunch` mode (GUI app, no reliable CLI shim). Copies primer + prints "open Claude Desktop manually and paste" hint.
- [x] `handoff doctor` — stale-shim detection (the `@handoff/cli` ghost install we kept hitting) plus empty-jsonl warnings.
- [x] `handoff init` — stop creating empty 1-byte `transcript.jsonl` / `tool-history.jsonl` files. They're created on first write by `capture` or `ingest` instead.
- [x] 113 → 159 tests (+46 new): paste adapter, capture command, desktop primer, install/switch/uninstall for desktop, doctor shim detection, init cleanup.

---

## Future (speculative)

**Gate:** do not build any of the below until at least one of — npm downloads >100/week, 3+ GitHub issues from non-Zohar accounts, or an unsolicited community shoutout. Until then, the v0.1–v0.7 surface is the product; adding more is scope creep in search of a user.

- **v8 — auto-rule promotion.** When the same correction theme appears 3+ times across a project's `.handoff/corrections.md`, offer to promote it into the tool-native rules file (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `GEMINI.md`) so the next agent inherits it as a hard instruction instead of a soft primer hint
- **v9 — adapter expansion.** Ingest for Aider, Continue.dev, Zed AI, Cline, Roo Code, Windsurf. Mechanical work; each adds ~200 LoC + tests. Only ship the adapters that match real users
- **v10 — real-time agent coordination.** `handoff lease "feature-X"` so two concurrent agents on the same `.handoff/` don't both think they own the same open loop. Extends the `withFileLock` primitive from v3 into a longer-held scoped lease
- **v11 — replay + diff.** `handoff replay --at <commit>` reconstructs the `.handoff/` state at an earlier git revision; `handoff diff` shows what an agent changed in a session. Useful for "what did Claude actually do last night" postmortems
- **v12 — git hooks.** `pre-commit` warns when `.handoff/open-loops.md` has open items ("you're committing but 3 loops are still open — intentional?"); optional `post-commit` auto-save. Opt-in via `handoff install --hooks`, off by default
- **Speculative v13+.** Editor statusbar extension (VSCode/Cursor/Zed) showing `.handoff/` state at a glance. Gated behind sustained usage

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
- Hosted coordination layer. If two agents need to coordinate across machines,
  they can share a git-backed `.handoff/`; running a server to mediate that
  reintroduces the cloud-sync dependency we explicitly rejected above.
- AI-generated roadmap entries. This file is curated by hand so the scope
  reflects real shipped work and real decisions, not an LLM's guess at what
  should come next.
