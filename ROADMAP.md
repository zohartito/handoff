# handoff — roadmap

Portable agent state across AI coding tools. This file is the single source of
truth for what's shipped, what's next, and what was explicitly cut. It doubles
as the changelog: each shipped section below maps to an npm release.

> Naming note: the `v0.1`/`v1.0`/`v1.5`/`v2.5`/`v3`/`v4`… section labels are
> internal milestone names, not semver. The actual package versions are the
> `0.x.y` numbers noted per section (npm + git tags).

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
- [x] Test suite across all 4 adapters: render parity, schema migration, compact primer, cross-platform, bug-injection validated (count grew per-milestone; 160 as of 0.7.1)
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

## v2 — Cursor MCP server (CUT → REVERSED in v8)

Originally planned: expose `.handoff/` as an MCP server so Cursor agents could
read/write handoff state natively instead of via files.

**Cut (April)** because `handoff switch` + `handoff ingest --from cursor`
already gave Cursor a no-friction path via SQLite + clipboard. MCP would add a
moving part without unlocking a capability the file-based path lacked — *for
Cursor*.

**Cut reversed (v8).** The "clipboard + ingest is enough" reasoning only ever
held for tools we have an adapter for. It has gone stale:

- **Kimi Code** stores sessions in a format we have no `ingest --from` adapter
  for, so there's no SQLite path to read.
- **The ChatGPT app** stores nothing locally readable at all.

For both, the clipboard primer is the *only* path today — a pre-MCP, manual
copy-paste interface. An MCP server gives any MCP-speaking agent (Codex,
Cursor, Claude Desktop, Kimi Code, the ChatGPT app) native mid-conversation
read/write access to handoff state, with no clipboard round-trip.

Shipped in v8 as `handoff mcp` (a stdio JSON-RPC 2.0 server, hand-rolled with
**no new dependency** — the zero-dep property is preserved). Tools:
`handoff_context`, `handoff_open_loops`, `handoff_log_correction`,
`handoff_log_attempt`, `handoff_log_decision`, `handoff_status`. See the README
"MCP server" section for the client config block.

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
- [x] `scripts/run-tests.mjs` cross-version test runner — enumerates `dist-test/tests/*.test.js` after TypeScript compilation, runs them together with `node --test`, and propagates the runner exit status
- [x] `HANDOFF_SEARCH_ROOTS` Windows path-delimiter fix — `path.delimiter` (`;` on Windows, `:` on POSIX) instead of hard-coded `:`, in both `src/commands/search.ts` and `src/commands/patterns.ts`

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
- [x] **0.7.1 patch** — caught in smoke test: Stream A added `file`/`stdin`/`clipboard` to `IngestOpts` but never registered them as commander `.option()`s, so `handoff ingest --from paste --file <path>` errored with `unknown option`. Fix wires the three flags through `cli.ts` and updates `--from`'s help text to list `paste`.

---

## v7.5 — repairs (shipped, 0.8.0)

**Not gated.** The gate below applies to *new surface*. Repairs to the shipped
v0.1–v0.7 surface ship freely: the tool's own data says the existing design
doesn't work as intended, and gating fixes behind stranger adoption means the
most important improvements wait on the least controllable signal.

The evidence that motivated this section: `.handoff/attempts.md` in this repo
logged 14 entries across two days (2026-04-16/17), then nothing for 3.5 months
across 13 commits; `corrections.md` has 2 entries ever. Meanwhile the artifact
itself sat frozen at the 0.4.0 era while the project shipped 0.7.1, still
listing "publish to npm" as an open loop, and nothing flagged it. A handoff
artifact that is confidently wrong is worse than none.

- [x] **Auto-capture at session stop.** Logs failed build/test attempts and user corrections from the transcript. **Later audited against real sessions and found to be low-yield** (0 of 395 messages under the original rules; a low single-digit count after widening them) — most corrections carry no cue word, so lexical detection cannot find them. Kept as a safety net; the mechanism that actually works is asking the outgoing agent to write the handoff. See v8.1.
- [x] **Staleness detection in `doctor`.** Flag an artifact that has drifted from reality: `meta.updatedAt` far behind the last commit, open loops matching things marked shipped, version strings disagreeing with `package.json`, logging that has gone silent.
- [x] **Relevance over recency in the primer.** Replace the `lastNEntries(raw, 3)` heuristic with promotion-by-repetition so durable rules survive compaction and one-offs decay. Reuses the theme-clustering already in `patterns.ts`.
- [x] **`handoff verify`.** Ask a receiving agent to restate task/constraints/do-nots and diff against the source. Today there is no feedback at all on whether a handoff landed.
- [x] **Re-inject mid-session.** Shipped as a `UserPromptSubmit` hook that re-surfaces standing rules only (silent, zero cost, when nothing has recurred). Note: the original plan named PreCompact, which turned out to be wrong — PreCompact output cannot survive into the post-compaction conversation, and compaction is already covered because SessionStart re-fires with `source: "compact"`. The real gap was ordinary drift *between* compactions.
- [x] **Trust boundary on injected content.** `.handoff/` is committed and auto-injected as system context; a cloned repo's artifact is attacker-authorable. Mark ingested/committed content as data rather than instructions.
- [x] **Fixed while validating:** `handoff switch` claimed a launch succeeded when the tool had already exited (terminal agents can't be launched detached — no TTY). Now watches the exit event.
- [x] **Adversarial pass.** Two verifiers attacked ranking and verify; every real defect they found is fixed and regression-tested. Notably: the ubiquity ceiling was dropping the most-repeated theme at >=5 varied-wording entries, compact primers had no budget enforcement (measured 7128 chars against a 2000 cap), and `verify` scored a correctly-formatted numbered-list answer as zero because the tokenizer skipped list lines.
- [x] **Dogfood loop.** session -> Stop hook auto-capture -> primer -> verify -> mid-session re-injection, run end to end on a scratch project. Found two further defects (block-form user messages invisible to capture; auto entries labelled `"auto"`), both fixed.
- [x] 232 -> 234 tests (v7.5 added ~70 across ranking, verify, auto-capture, staleness, re-injection and switch).

---

## v8 — measurable, native, installable (shipped, 0.9.0)

Three things the tool lacked, in the order that made each decidable.

- [x] **Retrieval eval (`handoff evaluate`).** The thresholds shipped in v7.5
  were chosen by reasoning, and nothing measured whether the ranking helped at
  all. This is a deterministic, offline information-retrieval eval over 7
  labelled scenarios: does the ranker surface the entries a human marked
  relevant to each task? No LLM, no API key, reproducible. It exists so the
  rest of this section is decided by numbers.
- [x] **MCP server (`handoff mcp`).** Reverses the v2 cut (see above). Six
  tools over hand-rolled stdio JSON-RPC 2.0 — **no new dependency**, so the
  zero-dep property survives.
- [x] **Task-relevant retrieval.** Replaces recency/recurrence for the primer
  tail. Standing rules remain the always-applies set.
- [x] **Plugin packaging.** `plugin/` + `.claude-plugin/marketplace.json`.
  Installation no longer depends on hand-editing `~/.claude/settings.json` —
  the failure that left hooks registered in exactly one repo.

### What the eval actually said

Macro-averaged F1 over 9 labelled scenarios:

| strategy | F1 |
|---|---|
| **shipped** (relevance ordering + recency backfill) | **0.685** |
| recurrence (was shipping) | 0.611 |
| relevance alone | 0.630 |
| recency (control) | 0.451 |

**An earlier version of this table claimed 0.810 vs 0.499 — that was
overstated and is corrected here.** Adversarial review showed the original
7-scenario corpus was favourable by construction: every scenario's "relevant"
entries shared surface vocabulary with the task, which is exactly what a lexical
scorer keys on, and 77% of the dramatic margin came from the two scenarios the
algorithm had been written around. Two scenarios covering the regime the corpus
could not see (`off-topic-critical`, `non-latin-task`) were added, and the
honest gap is much narrower.

**Four design instincts were measured and rejected or corrected**, which is the
point of building the instrument first:

1. Blending recurrence into the relevance score *hurts*. Weight ships at 0.
2. An abstention threshold discarded genuine matches before it helped anything.
   `minScore` ships at 0.
3. Aggressive stemming (`ing`/`es`) *lowered* F1 by over-stemming ("string" →
   "str"). Only `s`/`ies` ship.
4. The v7.5 `PROMOTION_THRESHOLD = 3` was **vindicated** — the sweep puts it on
   the optimal plateau.

### Defects adversarial review found after the fact

The eval justified shipping relevance selection; a verifier then showed that
wiring introduced regressions the corpus was structurally blind to:

- **One-off critical corrections vanished.** Selecting the tail purely by
  relevance dropped a "never commit secrets" correction whenever the current
  task was unrelated. Relevance now *orders* the tail and recency *backfills*
  it, so the floor is "no worse than before".
- **Non-Latin task text emptied the tail entirely.** The tokenizer splits on
  `[^a-z0-9]+`, so a task written in Hebrew or Chinese produced zero tokens and
  every score was 0. Same fix.
- **Keyword stuffing won retrieval.** `.handoff/` is attacker-authorable, and a
  correction stuffed with ~45 broad terms out-ranked genuine entries. Scoring
  now caps contributing terms and damps length harder.
- **A doc-frequency cliff.** Growing a corpus from 4 to 5 entries could flip
  retrieval from four hits to none. The hard ceiling is gone; IDF already damps
  ubiquitous terms continuously.

### What the eval does not measure

Retrieval quality only — whether the right entries reach the top of the list.
Not agent behaviour, not comprehension, not outcomes. The command prints this
caveat on every run.

---

## v8.1 — auto-capture audited against real sessions (shipped, 0.9.1)

Auto-capture shipped in v7.5 described as the thing that keeps `.handoff/`
current "without discipline". That claim was never tested on real data. It is
now, and it was wrong.

**Method.** Ran the detectors over 395 real user messages from 15 sessions
across 5 projects.

**Result.**

| Rule | Corrections caught |
|---|---|
| Original: message opens with a cue, <=240 chars | **0** of 395 |
| Cue anywhere in the first sentence, <=1000 chars | a low single-digit count |

Two causes, both measured: the 240-character cap excluded 70% of messages (the
real median is **425**), and requiring the message to *open* with a cue matched
2 messages where a sentence-anchored cue matched far more.

**But the deeper finding is not a tuning problem.** Most real corrections carry
no cue word at all — "But the whole idea is that they didn't turn it on at the
beginning" is a correction, and no lexical rule will ever see it. Widening the
rules moves 0 to a handful, not to useful.

**Changes:**

- [x] Cue matched at a sentence boundary within the first 300 chars, not only at
  message start.
- [x] Length cap 240 → 1000.
- [x] Filter harness-injected blocks (`<local-command-caveat>`, `<command-name>`,
  hook payloads) — these were being read as user speech and produced corrections
  attributed to a human who never typed them.
- [x] **Docs corrected.** README, plugin README and the `install` recipe no
  longer describe auto-capture as making handoff work "without discipline". It
  is documented as a low-yield safety net, with the measured numbers stated.

**What actually works**, and is now what the docs lead with: asking the outgoing
agent to write the handoff before the session ends, while it still has the whole
session in context. That produced, on a real project, a `corrections.md`
recording that the user's physical observations had repeatedly outranked agent
inference — with a standing rule to go measure before arguing. No heuristic
would ever have extracted that.

---

## Future (speculative)

**Gate:** do not build any *new surface* below until at least one of — npm downloads >100/week, 3+ GitHub issues from non-Zohar accounts, or an unsolicited community shoutout. Until then, the v0.1–v0.7 surface is the product; adding more is scope creep in search of a user. (Repairs to that existing surface are not gated — see v7.5 above.)

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
