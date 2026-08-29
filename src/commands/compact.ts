import { resolveHandoffPaths } from "../format/paths.js";
import { exists, readOrEmpty, writeFileSafe } from "../util/fs.js";
import { withFileLock } from "../util/lock.js";
import { hashEntry } from "../util/capture-state.js";

/**
 * `handoff compact` — the append → compact → archive lifecycle for the
 * unbounded log files (attempts.md, corrections.md, decisions.md).
 *
 * The logging commands (`attempt` / `correct` / `decide`, plus the Stop-hook
 * auto-capture) only ever APPEND. Over a long-lived project that log grows
 * without bound: the same failure gets re-logged every time it recurs (a real
 * `.handoff/` in the wild had the identical rate-limit failure recorded nine
 * times), and every session's primer pays to re-read all of it. `prime` loads
 * these files in full, so an append-only log is a linear, ever-growing token
 * tax on every future session.
 *
 * Compaction bounds that cost WITHOUT losing anything load-bearing:
 *   1. dedupe — byte-identical entries collapse into one, annotated with a
 *      `**seen:** N×` provenance line (first + last timestamp preserved).
 *   2. archive — once the distinct live set exceeds `keep`, the oldest distinct
 *      entries are relocated verbatim into a folded `## Archive` section so the
 *      live working set a fresh agent reads first stays bounded.
 *   3. validate — before the file is replaced we assert no distinct entry was
 *      lost and every original event is still accounted for in the counts.
 *
 * Compaction RELOCATES and COUNTS; it never rewrites an entry's prose. Lossy
 * summarization would risk dropping a load-bearing error trace, which is exactly
 * what these files exist to preserve (and it would cross the repo's determinism
 * boundary — the model judges, code stays exact). The archive is verbatim.
 */

/** Files that follow the append-only `## <timestamp>` … `---` entry format. */
const TARGET_KEYS = ["attempts", "corrections", "decisions"] as const;
export type CompactTarget = (typeof TARGET_KEYS)[number];

/** Distinct live entries kept above the archive fold by default. */
const DEFAULT_KEEP = 20;

const TS_HEADING = /^##\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/;
const ARCHIVE_HEADING = /^##\s+Archive\b/i;
const ARCHIVE_COMMENT = /^<!--\s*Older entries relocated/i;
const SEEN_LINE = /^\*\*seen:\*\*/i;

export type LogEntry = {
  /** Verbatim body (heading, separators and provenance line stripped). */
  body: string;
  /** Identity hash of the normalized body — matches auto-capture's scheme. */
  hash: string;
  /** How many original append events this entry now represents. */
  count: number;
  /** Timestamp of the earliest event in this entry (its heading). */
  firstTs: string;
  /** Timestamp of the most recent event folded into this entry. */
  lastTs: string;
};

export type CompactFileResult = {
  target: CompactTarget;
  /** File was missing / has no timestamped entries — left untouched. */
  skipped: boolean;
  /** Total append events found (summing any prior `**seen:**` counts). */
  inputEvents: number;
  /** Distinct entries after dedupe. */
  distinct: number;
  /** Duplicate events merged away (inputEvents - distinct). */
  merged: number;
  /** Distinct entries relocated below the archive fold. */
  archived: number;
  /** Whether the file content actually changed. */
  changed: boolean;
};

export type CompactOpts = {
  cwd?: string;
  /** Which log files to compact. Defaults to all three. */
  targets?: CompactTarget[];
  /** Distinct live entries to keep above the archive fold. */
  keep?: number;
  /** Report what would change without writing. */
  dryRun?: boolean;
  /** Injected date for the archive heading (tests). Defaults to today. */
  now?: Date;
  /** Suppress console output (used by tests). */
  quiet?: boolean;
};

export function isCompactTarget(s: string): s is CompactTarget {
  return (TARGET_KEYS as readonly string[]).includes(s);
}

/**
 * Split a log file into its verbatim preamble (title + guidance comments +
 * seeded non-timestamped sections) and its parsed timestamped entries. Any
 * previously-written archive scaffolding is dropped here so a re-compaction
 * treats live and archived entries uniformly (idempotence).
 */
export function parseLog(content: string): { preamble: string; entries: LogEntry[] } {
  const lines = content.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => TS_HEADING.test(l));
  if (firstIdx === -1) {
    return { preamble: content.replace(/\s+$/, ""), entries: [] };
  }

  const preamble = lines.slice(0, firstIdx).join("\n").replace(/\s+$/, "");
  const entries: LogEntry[] = [];

  let headingTs: string | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (headingTs === null) return;
    // Drop trailing separators / blanks, and any prior provenance line.
    const trimmed = [...bodyLines];
    while (
      trimmed.length &&
      (trimmed[trimmed.length - 1].trim() === "" || trimmed[trimmed.length - 1].trim() === "---")
    ) {
      trimmed.pop();
    }
    const seenLine = trimmed.find((l) => SEEN_LINE.test(l.trim()));
    const kept = trimmed.filter((l) => !SEEN_LINE.test(l.trim()));
    const body = kept.join("\n").replace(/^\n+|\n+$/g, "");

    let count = 1;
    let lastTs = headingTs;
    if (seenLine) {
      const cm = seenLine.match(/(\d+)\s*×/);
      if (cm) count = Math.max(1, parseInt(cm[1], 10));
      const lm = seenLine.match(/last\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/i);
      if (lm) lastTs = lm[1];
    }

    entries.push({
      body,
      hash: hashEntry("compact", [body]),
      count,
      firstTs: headingTs,
      lastTs,
    });
  };

  for (const line of lines.slice(firstIdx)) {
    const ts = line.match(TS_HEADING);
    if (ts) {
      flush();
      headingTs = ts[1];
      bodyLines = [];
      continue;
    }
    // Regenerated scaffolding: never fold it into an entry body.
    if (ARCHIVE_HEADING.test(line) || ARCHIVE_COMMENT.test(line)) {
      flush();
      headingTs = null;
      bodyLines = [];
      continue;
    }
    if (headingTs !== null) bodyLines.push(line);
  }
  flush();

  return { preamble, entries };
}

/** Merge byte-identical entries (by body hash), preserving order + provenance. */
function dedupe(entries: LogEntry[]): LogEntry[] {
  const byHash = new Map<string, LogEntry>();
  for (const e of entries) {
    const existing = byHash.get(e.hash);
    if (!existing) {
      byHash.set(e.hash, { ...e });
      continue;
    }
    existing.count += e.count;
    if (e.firstTs < existing.firstTs) existing.firstTs = e.firstTs;
    if (e.lastTs > existing.lastTs) existing.lastTs = e.lastTs;
  }
  // First-appearance order == chronological order for an append-only log.
  return [...byHash.values()].sort((a, b) => a.firstTs.localeCompare(b.firstTs));
}

function renderEntry(e: LogEntry): string {
  const provenance =
    e.count > 1 ? `**seen:** ${e.count}× (first ${e.firstTs}, last ${e.lastTs})\n\n` : "";
  return `## ${e.firstTs}\n\n${provenance}${e.body}\n\n---\n`;
}

/**
 * Pure compaction of one log file's text. Returns the rewritten content, the
 * live/archive split, and stats — or throws if the safety invariants (no
 * distinct entry dropped, every event still counted) don't hold.
 */
export function compactLog(
  content: string,
  opts: { keep?: number; now?: Date } = {},
): { output: string; stats: Omit<CompactFileResult, "target" | "skipped" | "changed"> } {
  const keep = opts.keep ?? DEFAULT_KEEP;
  const { preamble, entries } = parseLog(content);

  const inputEvents = entries.reduce((n, e) => n + e.count, 0);
  const distinctEntries = dedupe(entries);
  const distinct = distinctEntries.length;

  // Newest `keep` distinct entries stay live; the oldest surplus is archived.
  const archiveCount = Math.max(0, distinct - keep);
  const archived = distinctEntries.slice(0, archiveCount);
  const live = distinctEntries.slice(archiveCount);

  // --- Validation: nothing load-bearing may be lost before we replace. ------
  const inputHashes = new Set(entries.map((e) => e.hash));
  const outputHashes = new Set(distinctEntries.map((e) => e.hash));
  if (inputHashes.size !== outputHashes.size) {
    throw new Error(
      `compaction changed the distinct-entry set (${inputHashes.size} → ${outputHashes.size})`,
    );
  }
  for (const h of inputHashes) {
    if (!outputHashes.has(h)) throw new Error(`compaction would drop distinct entry ${h}`);
  }
  const outputEvents = distinctEntries.reduce((n, e) => n + e.count, 0);
  if (outputEvents !== inputEvents) {
    throw new Error(`compaction lost events (${inputEvents} → ${outputEvents})`);
  }
  if (distinct > entries.length) {
    throw new Error(`compaction invented entries (${entries.length} → ${distinct})`);
  }

  // --- Render -------------------------------------------------------------
  const parts: string[] = [preamble.replace(/\s+$/, "")];
  for (const e of live) parts.push("\n" + renderEntry(e));
  if (archived.length > 0) {
    const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
    parts.push(
      `\n## Archive (compacted ${date})\n\n` +
        `<!-- Older entries relocated here by \`handoff compact\`. Verbatim and ` +
        `provenance-preserving; read the live entries above first. -->\n`,
    );
    for (const e of archived) parts.push("\n" + renderEntry(e));
  }
  const output = parts.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "") + "\n";

  return {
    output,
    stats: {
      inputEvents,
      distinct,
      merged: inputEvents - distinct,
      archived: archived.length,
    },
  };
}

export async function compact(opts: CompactOpts = {}): Promise<CompactFileResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);
  const quiet = !!opts.quiet;

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return [];
  }

  const targets = opts.targets && opts.targets.length > 0 ? opts.targets : [...TARGET_KEYS];
  const results: CompactFileResult[] = [];

  for (const target of targets) {
    const path = paths[target];
    const before = await readOrEmpty(path);
    const parsed = parseLog(before);

    if (parsed.entries.length === 0) {
      results.push({
        target,
        skipped: true,
        inputEvents: 0,
        distinct: 0,
        merged: 0,
        archived: 0,
        changed: false,
      });
      if (!quiet) console.log(`${target}.md: no timestamped entries — skipped`);
      continue;
    }

    let output: string;
    let stats: Omit<CompactFileResult, "target" | "skipped" | "changed">;
    try {
      const r = compactLog(before, { keep: opts.keep, now: opts.now });
      output = r.output;
      stats = r.stats;
    } catch (err) {
      process.exitCode = 1;
      if (!quiet) {
        console.error(
          `${target}.md: compaction aborted (file untouched) — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      continue;
    }

    const changed = output !== before;
    if (changed && !opts.dryRun) {
      await withFileLock(path, () => writeFileSafe(path, output));
    }

    results.push({ target, skipped: false, changed, ...stats });

    if (!quiet) {
      const verb = opts.dryRun ? "would" : changed ? "compacted" : "unchanged";
      const bits = [
        `${stats.inputEvents} event${stats.inputEvents === 1 ? "" : "s"}`,
        `${stats.distinct} distinct`,
      ];
      if (stats.merged > 0) bits.push(`${stats.merged} dup${stats.merged === 1 ? "" : "s"} merged`);
      if (stats.archived > 0) bits.push(`${stats.archived} archived`);
      console.log(`${target}.md: ${verb} — ${bits.join(", ")}`);
    }
  }

  return results;
}
