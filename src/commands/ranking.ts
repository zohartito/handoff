import { extractNgrams } from "../util/ngrams.js";

/**
 * Relevance ranking for append-only entry logs (`corrections.md`, `attempts.md`).
 *
 * The primer used to keep the three most RECENT entries. Recency is not
 * relevance: a rule the user restated across five sessions ("always prefer
 * pathlib") outranks three fresh one-offs, yet it silently fell out of the
 * recent-3 window.
 *
 * The insight that makes this tractable without NLP: repetition already lives
 * in the data. Each `handoff correct` appends a separate timestamped entry, and
 * entries about the same thing share vocabulary. So "durable rule" = an n-gram
 * that recurs across N distinct entries.
 *
 * Nothing is ever deleted — these files stay append-only. Ranking is a
 * read-time view.
 */

/** Recurrences across distinct entries needed to promote a theme to a standing rule. */
export const PROMOTION_THRESHOLD = 3;

/**
 * Higher bar for clusters made up entirely of auto-captured entries. A human
 * bothering to type `handoff correct` is strong signal; a hook emitting entries
 * is weaker and higher-volume, so a pattern no human ever confirmed must be
 * substantially more frequent before we present it as a hard constraint.
 */
export const AUTO_ONLY_PROMOTION_THRESHOLD = 5;

export interface StandingRule {
  /** Condensed one-line form of the cluster's representative entry. */
  line: string;
  /** How many distinct entries share this theme. */
  count: number;
}

export interface RankedEntries {
  standing: StandingRule[];
  /** Full entries, most recent last, with promoted-cluster members removed. */
  recent: string[];
}

export interface RankOpts {
  recentN: number;
  maxStanding: number;
  promotionThreshold?: number;
  /** Identifies machine-captured entries. Defaults to reading a `source: auto` marker. */
  isAuto?: (entry: string) => boolean;
}

/**
 * Split a markdown doc (`attempts.md`, `corrections.md`) into its top-level
 * entries. Entries are appended by `handoff attempt|correct` using a
 * `## <ISO-timestamp>` header followed by a trailing `---`. We split on
 * `## ` headers when present; fall back to `\n---\n` separators otherwise.
 *
 * Returns entries in original order, with the file's `# Title` + HTML
 * comment banner stripped.
 */
export function splitEntries(raw: string): string[] {
  const cleaned = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/^#\s+[^\n]*\n/, "");
  const trimmed = cleaned.trim();
  if (!trimmed) return [];

  // Primary strategy: split on `## ` H2 headers (what attempt/correct emit).
  if (/^## /m.test(trimmed)) {
    const parts = trimmed.split(/\n(?=## )/g);
    return parts
      .map((p) => p.replace(/\n---\s*$/g, "").trim())
      .filter((p) => p.length > 0);
  }

  // Fallback: entries separated only by `---` dividers.
  return trimmed
    .split(/\n---\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Return the last N entries from a markdown doc, preserving original order. */
export function lastNEntries(raw: string, n: number): string[] {
  const entries = splitEntries(raw);
  return entries.slice(-n);
}

/**
 * Strip an entry down to the text worth tokenizing.
 *
 * Every entry carries the same scaffolding — a `## <timestamp>` header and
 * `**agent did:** / **user said:** / **tried:** / **fix:**` field labels. Those
 * labels are identical across all entries, so tokenizing them makes words like
 * "agent" appear in 100% of entries and turns the boilerplate itself into the
 * dominant "theme", clustering unrelated corrections together. Keep the values,
 * drop the labels.
 */
export function entryTextForRanking(entry: string): string {
  return entry
    .split("\n")
    .filter((l) => !/^##\s/.test(l.trim()))
    .join("\n")
    .replace(/\*\*[a-z][a-z ]*:\*\*/gi, " ");
}

/** Default auto-detection: entries tagged by the Stop-hook capture path. */
function defaultIsAuto(entry: string): boolean {
  return /^\*\*source:\*\*\s*auto\s*$/im.test(entry);
}

/**
 * An entry marked superseded is excluded from ranking entirely. The marker has
 * no producer yet — the data path exists ahead of a future `handoff supersede`
 * so that ranking need not change when it lands.
 */
function isSuperseded(entry: string): boolean {
  return /^\*\*superseded:\*\*\s*true\s*$/im.test(entry);
}

/**
 * Fraction of entries an n-gram may appear in before it counts as corpus
 * boilerplate rather than a theme.
 *
 * A word present in every entry ("always", "use") has no discriminative power —
 * it would out-rank every real theme and merge unrelated entries into one
 * meaningless cluster. This is a corpus-specific stopword filter: the global
 * STOPWORDS list can't know that a given project phrases every correction as
 * "always ... here". Only applied once there are enough entries to judge.
 */
const UBIQUITY_CEILING = 0.6;
const MIN_ENTRIES_FOR_UBIQUITY_FILTER = 5;

/**
 * Pick the entry's dominant theme: the n-gram it contains that recurs across
 * the most entries. Ties break toward the longer n-gram ("os path" is more
 * specific than "path"), then alphabetically so output is deterministic.
 */
function dominantNgram(
  ngrams: ReadonlySet<string>,
  entryFreq: ReadonlyMap<string, number>,
  totalEntries: number,
): string | null {
  const ceiling =
    totalEntries >= MIN_ENTRIES_FOR_UBIQUITY_FILTER
      ? totalEntries * UBIQUITY_CEILING
      : Infinity;

  const pick = (max: number): string | null => {
    let best: string | null = null;
    let bestFreq = 0;
    for (const g of ngrams) {
      const freq = entryFreq.get(g) ?? 0;
      if (freq > max) continue;
      if (freq > bestFreq) {
        best = g;
        bestFreq = freq;
        continue;
      }
      if (freq === bestFreq && best !== null) {
        const gWords = g.split(" ").length;
        const bWords = best.split(" ").length;
        if (gWords > bWords || (gWords === bWords && g < best)) best = g;
      }
    }
    return best;
  };

  // Prefer a discriminative theme. But if everything this entry contains is
  // ubiquitous, the ubiquitous term IS the theme — a corrections file that is
  // entirely about one thing should still promote that one thing.
  return pick(ceiling) ?? pick(Infinity);
}

/**
 * Condense an entry to a single line for the standing-rules list. Prefers the
 * distilled lesson, then what the user actually said, then what was tried —
 * i.e. the most rule-shaped field available.
 */
export function condenseEntry(entry: string): string {
  const pick = (label: RegExp): string | null => {
    const m = entry.match(label);
    return m && m[1] ? m[1].trim() : null;
  };
  const text =
    pick(/^\*\*lesson:\*\*\s*(.+)$/im) ??
    pick(/^\*\*user said:\*\*\s*(.+)$/im) ??
    pick(/^\*\*tried:\*\*\s*(.+)$/im) ??
    pick(/^\*\*agent did:\*\*\s*(.+)$/im) ??
    // Fall back to the first non-header, non-empty line.
    entry
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith("---")) ??
    "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Rank a log's entries into standing rules (recurring themes, condensed and
 * deduped) plus a recent tail (full entries not already represented above).
 */
export function rankEntries(raw: string, opts: RankOpts): RankedEntries {
  const threshold = opts.promotionThreshold ?? PROMOTION_THRESHOLD;
  const isAuto = opts.isAuto ?? defaultIsAuto;

  const all = splitEntries(raw).filter((e) => !isSuperseded(e));
  if (all.length === 0) return { standing: [], recent: [] };

  // Presence per entry, not raw count: a word repeated inside one entry is
  // still only one entry's worth of signal.
  const perEntry = all.map(
    (e) => new Set(extractNgrams(entryTextForRanking(e)).keys()),
  );

  const entryFreq = new Map<string, number>();
  for (const set of perEntry) {
    for (const g of set) entryFreq.set(g, (entryFreq.get(g) ?? 0) + 1);
  }

  // Group entry indices by dominant theme.
  const clusters = new Map<string, number[]>();
  all.forEach((_, i) => {
    const key = dominantNgram(perEntry[i]!, entryFreq, all.length);
    if (!key) return;
    const bucket = clusters.get(key);
    if (bucket) bucket.push(i);
    else clusters.set(key, [i]);
  });

  const promotedIdx = new Set<number>();
  const standing: StandingRule[] = [];

  for (const [, idxs] of clusters) {
    if (idxs.length < threshold) continue;
    const handLogged = idxs.filter((i) => !isAuto(all[i]!));
    // A cluster no human ever confirmed needs a substantially higher bar.
    if (handLogged.length === 0 && idxs.length < AUTO_ONLY_PROMOTION_THRESHOLD) continue;

    // Representative = newest hand-logged entry if any (cheap superseding:
    // a refined restatement wins), else newest overall.
    const pool = handLogged.length > 0 ? handLogged : idxs;
    const repIdx = pool[pool.length - 1]!;
    const line = condenseEntry(all[repIdx]!);
    if (!line) continue;

    standing.push({ line, count: idxs.length });
    for (const i of idxs) promotedIdx.add(i);
  }

  // Strongest themes first; stable tie-break on text keeps output deterministic.
  standing.sort((a, b) => b.count - a.count || a.line.localeCompare(b.line));

  const recent = all
    .map((entry, i) => ({ entry, i }))
    .filter(({ i }) => !promotedIdx.has(i))
    .slice(-opts.recentN)
    .map(({ entry }) => entry);

  return { standing: standing.slice(0, opts.maxStanding), recent };
}
