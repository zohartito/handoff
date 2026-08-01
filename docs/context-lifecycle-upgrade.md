# Context-lifecycle upgrade — grounding the ACM digest in `handoff`

Source: 2026-07-27 digest of "Agentic Context Management" (arXiv 2607.21503).
Digest: `Brain/Knowledge/Research/2026-07-27-agentic-context-management.md`

This doc checks each of the paper's 3 proposed changes against the actual codebase
**before** proposing work. Every "already there / not there" claim cites a file:line.

**Constraint that shapes everything below:** `package.json:48-50` — the only runtime
dependency is `commander` (confirmed at `README.md:275`, `ROADMAP.md:20`). There is no LLM
client anywhere in `src/`. All "summarization" today is deterministic extraction, not
paraphrase.

---

## 1. Validated compaction — REAL GAP

**Already there?** No. `grep -rniE "recall|validat|compaction|compress" src/` returns zero
hits related to content-fidelity checking.

- `src/commands/prime.ts:249-254` `truncate()` — chops the primer at 85% head / tail by raw
  character count. No awareness of what got cut.
- `src/commands/prime.ts:297-372` `buildCompactPrimer()` — unconditionally drops
  `decisions.md`, `codebase-map.md`, `references.md`, `identity.md`; keeps only the latest 3
  entries of `attempts`/`corrections`. No check that anything load-bearing survived.
- `src/commands/ingest.ts:465-705` `summarizeSession()`/`renderMarkdown()` — the real
  transcript → handoff-note compaction. Currently **deterministic** (verbatim quotes,
  tool-call tallies, last 3 assistant messages), so it doesn't hit the paper's specific
  failure mode (semantic drift). But it silently truncates (`errors.slice(0, 20)`,
  `bashCommands...slice(0,30)`) with no signal to the reading agent about what was cut.

The paper's reference design (LLM-generated recall questions + verification) would add a
network dep, API key, latency, and cost — contradicting `README.md:271-275` ("local-first…
zero runtime deps"). So: **two tiers, and only tier 1 is in scope here.**

### Tier 1 — heuristic anchor coverage (dependency-free)

```ts
export type CompactionCheck = {
  score: number;            // fraction of anchors preserved, 0..1
  missingAnchors: string[];
};

/** Cheap "must survive" anchors: file paths, first line of each error. */
export function extractAnchors(
  filesTouched: Set<string>,
  errors: ErrorHit[],
): string[] {
  const anchors = [...filesTouched];
  for (const e of errors) anchors.push(e.error.split("\n")[0].slice(0, 60));
  return [...new Set(anchors)];
}

export function checkCompaction(anchors: string[], rendered: string): CompactionCheck {
  const missingAnchors = anchors.filter((a) => !rendered.includes(a));
  const score = anchors.length === 0 ? 1 : 1 - missingAnchors.length / anchors.length;
  return { score, missingAnchors };
}
```

Call site in `summarizeSession`: run `checkCompaction` after `renderMarkdown`; if
`score < 0.8`, re-render with lighter caps (`errors.slice(0, 40)`,
`bashCommands...slice(0, 60)`) — the paper's "retry with less aggressive compression."
Append `**Compaction score:** 0.83 (2 anchors dropped)` so the signal is visible instead of
silent.

Also: `prime.ts` `buildCompactPrimer`/`truncate` should refuse to drop a section if that
would remove the only mention of an open-loop or decision keyword still referenced elsewhere.

**Effort:** S/M — new pure functions + one retry branch, testable in isolation like the rest
of `ingest.ts`'s exported helpers. Tier 2 (LLM-graded recall) is **L** and breaks the
zero-dep line — decide it separately, don't bundle it.

**What could break:** the supersede-not-append ingest-persistence contract
(`ROADMAP.md:156`) if the retry path double-writes; existing `ingest.test` needs fixtures
for the low-score/retry path.

---

## 2. Typed sections — ALREADY DONE (one small parity gap)

The digest's "freeform blob" framing does not match this repo.

- `src/format/templates.ts:8-216` defines discrete typed files: `task.md`, `progress.md`,
  `decisions.md`, `attempts.md`, `corrections.md`, `identity.md`, `environment.md`,
  `codebase-map.md`, `open-loops.md`, `references.md`.
- `src/format/paths.ts:3-47` wires each as its own resolvable path — not a single log.
- `src/commands/decide.ts:22-38` appends structured, timestamped entries
  (`## <ISO>` / `**chose:**` / `**because:**` / `**considered:**`).
- `src/commands/capture.ts:170-195` `extractMarkers()` already does marker-based typed
  routing: `TASK:` → `task.md`, `TODO:` → `progress.md`, `DECISION:` → `decisions.md`,
  `CORRECTION:` → `corrections.md` (dispatch at `capture.ts:70-106`). Shipped v7
  (`ROADMAP.md:168`).

Mapping the digest's four slots: **open-questions** = `open-loops.md` ✅,
**next-actions** = `progress.md`'s `## Next` ✅, **decisions** = `decisions.md` ✅,
**facts** = ❌ nowhere typed. Facts get folded into `codebase-map`/`references`/`environment`
free text or dropped; `extractMarkers` has no `FACT:` case.

**Do not rebuild the section system.** The only work is parity — add `facts.md` + `FACT:`
marker, matching the existing pattern exactly.

Touch points (all 5 required — the primer array is hand-maintained, not derived):
- `src/format/templates.ts` — new `"facts.md"` entry (copy `decisions.md` shape)
- `src/format/paths.ts` — `facts: resolve(dir, "facts.md")`
- `src/commands/init.ts:50-67` `resolveTemplateTarget` — add mapping
- `src/commands/capture.ts:170-195` — add `FACT` to the marker regex/switch
- `src/commands/prime.ts:88-99` — add `{ label: "Facts", path: paths.facts }`
  (probably exclude from compact mode, matching `codebase-map`/`identity` at `prime.ts:297-372`)

Optional `src/commands/fact.ts`, mirroring `decide.ts`:

```ts
export async function fact(opts: FactOpts): Promise<void> {
  const paths = resolveHandoffPaths(opts.cwd ?? process.cwd());
  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }
  const ts = new Date().toISOString();
  const entry = [`## ${ts}`, ``, `**fact:** ${opts.statement}`,
    opts.asOf ? `\n**as of:** ${opts.asOf}` : null, ``, `---`, ``]
    .filter(Boolean).join("\n");
  await withFileLock(paths.facts, () => appendLine(paths.facts, "\n" + entry));
}
```

**Effort:** S. Purely additive; `init.ts:25` is `Object.entries`-driven so a new template
auto-scaffolds. Only risk is forgetting one of the 5 touch points.

---

## 3. Two-tier scope — REAL GAP, but touches a stated guarantee

**Partially there, one-directional:**

- `src/commands/obsidian.ts:32-117` (`handoff obsidian sync`) already promotes
  `decisions.md`/`corrections.md` into a vault as `Decisions/<date>_<project>_<slug>.md` and
  `Rules/<project>__<slug>.md`. Shipped v4 (`ROADMAP.md:118-136`).
- `handoff search` / `handoff patterns` (`ROADMAP.md:129-136`) scan every `.handoff/` on the
  machine on demand.
- **But nothing flows back.** Full read of `buildPrimer` / `buildCompactPrimer` /
  `buildSubagentPrimer` (`prime.ts:57-465`) shows zero code path reading anything outside the
  current project's `.handoff/` into a session primer.

**`README.md:272` states as an explicit design tenet: "Per-project. Each repo owns its own
`.handoff/`. No cross-project leaks."** A read-first global layer *revises that architecture*.
It must ship with a doc update, or be strictly opt-in (env var unset ⇒ zero behavior change).

Where it goes:
- `src/format/paths.ts` — `resolveGlobalHandoffPath()` → `~/.handoff/global.md`, overridable
  via `HANDOFF_GLOBAL_PATH` (same pattern as `HANDOFF_OBSIDIAN_VAULT` / `HANDOFF_SEARCH_ROOTS`;
  cross-platform home-dir precedent exists in `src/adapters/cursor.ts`, `ROADMAP.md:54`)
- `src/commands/prime.ts:57-112` — read it like `ingestedContext` (`prime.ts:78-86`), prepend
  as its own section
- Promotion path — either `--global` on `decide`/`correct`, or `handoff promote <entry-id>`
  reusing `splitEntries` (`prime.ts:265-283`)

```ts
const globalRaw = cleanBody(await readOrEmpty(resolveGlobalHandoffPath()));
if (globalRaw) {
  parts.splice(1, 0, { title: "Global (cross-repo) context", body: globalRaw });
}
```

**Effort:** M. **What could break:** contradicts `README.md:272`; becomes a *third* competing
cross-repo surface alongside Obsidian sync and search/patterns. `ROADMAP.md:181` gates new
speculative surface area behind real usage signals (100+ weekly downloads, 3+ external
issues) — weigh this against that policy before building.

---

## Do-first (value ÷ effort)

1. **Typed `facts.md`** — S, mechanical 5-file parity fix, zero architectural risk.
2. **Validated compaction, heuristic tier** — S/M, addresses the paper's headline empirical
   claim (the 66.7% → 57.1% accuracy cliff) with no new dependency.
3. **Two-tier scope** — M, real value but most overlap with shipped features and the only one
   requiring revision of a stated architectural guarantee. Do last.
