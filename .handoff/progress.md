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

Everything through v7 has shipped and is published as `@zohartito/handoff@0.7.1`.
Full per-milestone history lives in `ROADMAP.md` (it doubles as the changelog).
Summary:

- **v0.1–v1.0 (0.1.x):** init/status/save/attempt/decide/correct lifecycle, primers for all tools, Claude Code hooks, ingest adapters for claude-code / cursor / codex / gemini, switch, doctor, uninstall, npm + GitHub published.
- **v1.5–v1.6 (0.2.0):** ingest --all, compact primer, tool-tuned primers, schema migration framework, cross-platform audit, launchers in `scripts/`.
- **v2.5/v3 (0.3.0):** one-button `switch` (save+prime+clipboard+launch), agent-initiated handoff protocol in primers, in-session slash commands, subagent primer, `withFileLock` concurrency safety.
- **v4 (0.4.0):** `obsidian sync` (Daily/Decisions/Rules), `handoff search`, `handoff patterns`.
- **v5 (0.5.0):** CI matrix ubuntu/macos/windows × Node 22/24, engines >=22.5, test runner script.
- **v6 (0.6.0):** ingest persists to `.handoff/ingested-context.md`, prime surfaces it.
- **v7 (0.7.0/0.7.1):** `ingest --from paste`, `handoff capture`, Claude Desktop primer/install/switch, doctor stale-shim + empty-jsonl detection.
- **2026-07-31 audit pass:** full macOS re-validation at 0.7.1 (160/160 tests, all CLI commands live, pbcopy clipboard verified), docs synced to reality, missing `lint` script added, `prime --tool <unknown>` now rejects, git tags v0.1.0–v0.4.0 backfilled, dependabot ignores TS majors.

## In flight

_(none — maintenance mode)_

## Blocked

- **Pre-rate-limit detection**: Claude Code only fires `StopFailure` after the rate-limit hits. Blocked upstream until Claude Code exposes a pre-rate-limit event. Tracked in `README.md` "Known limitations".

## Next

Adoption-gated (see ROADMAP "Future"): don't build v8+ (auto-rule promotion,
Aider/Continue/Zed adapters, lease coordination, replay/diff, git hooks,
statusbar extension) until npm >100 downloads/wk OR 3+ external issues OR a
community shoutout.

Remaining validation loose ends are in `open-loops.md` (live Linux desktop,
macOS launch-spawn, cursor real-data parse).
