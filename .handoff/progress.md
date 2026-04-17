# Progress

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works. When an agent picks up this project, it should read every
file in this directory before taking action.
-->

<!--
What's done, what's in flight, what's blocked, what's next.
Update as state changes. Delete stale items.
-->

## Done

### v0.1 — foundations (shipped)
- `handoff init` scaffolds `.handoff/` in any project
- `handoff attempt|decide|correct|save|status` lifecycle commands
- `handoff prime --tool <tool>` emits a primer for any target tool
- `handoff install --tool claude-code|cursor` prints integration recipe
- Claude Code hooks (SessionStart / Stop / StopFailure rate_limit) auto-inject the primer

### v1.0 — multi-tool ingest (shipped @ 0.1.x)
- `handoff ingest --from claude-code` parses `~/.claude/projects/<enc>/*.jsonl`
- `handoff ingest --from cursor` reads Cursor's SQLite state.vscdb via `node:sqlite`
- `handoff ingest --from codex` parses `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- `handoff ingest --from gemini` parses `~/.gemini/tmp/<hash>/chats/*.json`
- `handoff switch <tool>` — save + prime + clipboard + launch in one shot
- `handoff doctor` scans project + global install for common issues
- `handoff uninstall --tool <tool>` prints removal instructions
- Cross-tool round-trip test — Codex-validated; all 4 primers 4/4; caught one ingest scoping bug that shipped as 0.1.1
- Published `@zohartito/handoff@0.1.0` → `0.1.1` to npm
- Repo live at github.com/zohartito/handoff

### v1.5 — polish (shipped @ 0.2.0)
- `handoff ingest --all` orchestrator across all 4 sources with graceful per-source fallback
- Compact primer mode (`--compact`, <2k chars typical)
- Tool-tuned codex + gemini primers (apply_patch / @-references mappings)
- Schema migration framework in `src/format/migrate.ts` (`loadMeta`)
- Cross-platform audit: linux clipboard cascade (wl-copy → xclip → xsel), Cursor user dir per-OS, case-sensitivity fix; see `CROSS-PLATFORM.md`
- `corrections.md` template seeded with "don't re-explain the project" rule
- Doctor: detects hooks-configured-but-handoff-not-in-PATH
- 37 → 74 tests (0 regressions)

## In flight

_(none — v1.5 just shipped)_

## Blocked

- **Pre-rate-limit detection**: Claude Code only fires `StopFailure` after the rate-limit hits. Blocked upstream until Claude Code exposes a pre-rate-limit event. Tracked in `README.md` "Known limitations" and as a v3 precondition.

## Next

### v1.6 — loose ends (small)
- Live mac/linux validation pass (code-audited, not hardware-tested; see `CROSS-PLATFORM.md` → "Requires live testing")
- System-tray / keyboard-shortcut variant of `handoff switch` (deferred from v2.5)

### v3 — agent-initiated handoffs (planned)
- Primer detects "about to hit rate limits" signal
- In-session slash command triggers `handoff switch` without leaving the session
- Claude Code subagent primer variant (spawned agents inherit `.handoff/` context)
- Multi-agent coordination (file locking / JSONL append semantics for 2+ tools on same `.handoff/`)

### v4 — permanent memory (planned)
- Obsidian vault integration — session summaries → daily notes, decisions → Decisions/, corrections → rules
- `handoff search "<query>"` across all projects' `.handoff/`
- Auto-extract cross-project patterns
