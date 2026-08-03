import { extractNgrams } from "../util/ngrams.js";
import {
  entryId,
  entryTextForRanking,
  rankEntries,
  splitEntries,
  PROMOTION_THRESHOLD,
} from "./ranking.js";

/**
 * Task-aware retrieval.
 *
 * The shipping ranker (`ranking.ts`) is task-BLIND: it orders corrections by how
 * often a theme recurs, never reading what you're actually doing. The retrieval
 * eval showed exactly what that costs — two scenarios score 0:
 *
 * - a critical correction stated ONCE can never resurface, because recurrence is
 *   the only currency;
 * - a large irrelevant cluster (a formatting nag repeated 5×) fills the whole
 *   cutoff and buries the one on-topic entry.
 *
 * Both are relevance failures, not recurrence failures. This module scores
 * entries by overlap with the current task instead, and blends in recurrence as
 * a bonus rather than the sole signal.
 *
 * Deliberately lexical (TF-IDF-ish over the shared n-gram tokenizer): no
 * embeddings, no model call, no dependency, and identical output for identical
 * input. The tradeoff is the usual one — synonyms are invisible.
 */

/**
 * Weight applied to the recurrence bonus. **Zero by default, chosen by
 * measurement rather than taste.**
 *
 * The intuition was that blending "how often has this recurred" into "how well
 * does this match the task" would beat either alone. The eval said otherwise:
 * every non-zero weight scored strictly worse than pure relevance, because the
 * bonus drags frequent-but-irrelevant entries back up — the exact failure
 * task-awareness was added to fix.
 *
 * The knob stays so the finding is re-testable on a larger corpus
 * (`handoff evaluate --compare`), but the default encodes the measurement.
 */
export const RECURRENCE_WEIGHT = 0;

/**
 * Most matched terms that may contribute to one entry's score.
 *
 * Without a cap, score is a *sum* over matched terms, so an entry can win purely
 * by breadth. `.handoff/` is attacker-authorable (clone a hostile repo), and a
 * single correction stuffed with ~45 broad keywords out-ranked genuinely
 * on-topic entries on unrelated tasks — it was retrieved first for "refactor the
 * react cart reducer" *and* "add a file download endpoint". Capping at the
 * strongest few matches means a stuffed entry gets no more credit than a
 * precise one, while honest entries (which rarely match more than a handful of
 * distinctive terms) are unaffected.
 */
const MAX_SCORING_TERMS = 8;

/**
 * Exponent on entry length when normalising the score.
 *
 * Chosen against both the eval and the stuffing attack. At 0.5 (plain sqrt) the
 * keyword-stuffed entry still out-ranked a genuinely on-topic one for "add a
 * file download endpoint" (0.88 vs 0.87). At 0.8 the legitimate entry wins
 * clearly (0.44 vs 0.23) at no cost to eval F1 — the only cost is a marginal
 * MRR dip, i.e. the first relevant hit sits slightly lower on average. That's a small, universal cost for a real adversarial property, and
 * the primer backfills by recency regardless, so nothing is lost either way.
 */
const LENGTH_DAMPING = 0.8;

/**
 * Collapse a token to a crude stem so "migration" matches "migrations" and
 * "log" matches "logs".
 *
 * Without this, the retriever missed obvious matches purely on plurals — a task
 * saying "write the migration" scored zero against a correction saying "run
 * migrations in a transaction".
 *
 * Only `s` and `ies` are stripped, and that restraint is measured. A first pass
 * also stripped `ing` and `es`, which *lowered* eval F1 by over-stemming
 * ("string" → "str", producing false matches). The conservative pair keeps the
 * score while fixing the plural misses — strictly better than both the
 * aggressive version and no stemming at all.
 *
 * Deliberately not a real stemmer: the whole module is a zero-dependency
 * lexical scorer. Guarded on length so short words aren't mangled.
 */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ["ies", "s"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return suffix === "ies" ? `${token.slice(0, -3)}y` : token.slice(0, -suffix.length);
    }
  }
  return token;
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const gram of extractNgrams(text, { includeListLines: true }).keys()) {
    out.add(gram.split(" ").map(stem).join(" "));
  }
  return out;
}

/**
 * Inverse document frequency over the corpus. A term in every entry can't
 * discriminate; a term in one entry is highly informative when the task
 * mentions it.
 */
export function buildIdf(entryTexts: string[]): Map<string, number> {
  const n = Math.max(entryTexts.length, 1);
  const df = new Map<string, number>();
  for (const text of entryTexts) {
    for (const t of tokens(entryTextForRanking(text))) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  // No hard ceiling. A cutoff at a fixed entry count created a cliff — adding
  // one harmless entry to a 4-entry corpus flipped retrieval from four hits to
  // nothing, because a shared term crossed the threshold and was deleted
  // outright. IDF already damps ubiquitous terms continuously (a term in every
  // entry scores log(2), a unique one in a 20-entry corpus scores log(21)), so
  // the extra switch bought nothing but a discontinuity.
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + n / count));
  }
  return idf;
}

/**
 * Similarity between a task and one entry: summed IDF of the strongest shared
 * terms, dampened by entry length so a long or keyword-stuffed entry can't win
 * on surface area alone.
 */
export function relevanceScore(
  taskTerms: ReadonlySet<string>,
  entryText: string,
  idf: ReadonlyMap<string, number>,
): number {
  const entryTerms = tokens(entryTextForRanking(entryText));
  if (entryTerms.size === 0) return 0;

  const matched: number[] = [];
  for (const t of entryTerms) {
    if (taskTerms.has(t)) matched.push(idf.get(t) ?? 0);
  }
  if (matched.length === 0) return 0;

  // Strongest matches only: breadth of weak matches must not beat depth of
  // strong ones, or keyword-stuffing wins.
  const score = matched
    .sort((a, b) => b - a)
    .slice(0, MAX_SCORING_TERMS)
    .reduce((sum, v) => sum + v, 0);

  return score / Math.pow(entryTerms.size, LENGTH_DAMPING);
}

/**
 * How many entries share each entry's promoted theme, keyed by entry id.
 * Entries in no promoted cluster get 1 (they are their own singleton).
 */
export function clusterSizes(
  raw: string,
  threshold = PROMOTION_THRESHOLD,
): Map<string, number> {
  const sizes = new Map<string, number>();
  const big = Math.max(splitEntries(raw).length, 1);
  const ranked = rankEntries(raw, {
    recentN: big,
    maxStanding: big,
    promotionThreshold: threshold,
    withIds: true,
  });
  ranked.standingIds?.forEach((group, i) => {
    const count = ranked.standing[i]?.count ?? group.length;
    for (const id of group) sizes.set(id, count);
  });
  return sizes;
}

export interface ScoredEntry {
  id: string;
  text: string;
  score: number;
}

export interface RetrieveOpts {
  /** 0 = pure task relevance, higher = more weight on how often a theme recurs. */
  recurrenceWeight?: number;
  /**
   * Drop entries scoring at or below this, letting the retriever return
   * nothing at all.
   *
   * Defaults to 0 (never abstain) — also a measured choice. Abstaining on a
   * corpus where nothing is relevant is desirable in principle, but every
   * threshold high enough to trigger it discarded genuine matches elsewhere
   * first — every threshold high enough to trigger abstention cost more in
   * lost true positives than it gained. Cheap abstention needs a
   * signal this scorer doesn't have.
   */
  minScore?: number;
}

/**
 * Rank entries for a task, best first.
 *
 * Unlike the recurrence ranker this can legitimately return FEWER than asked
 * for — when nothing in the corpus relates to the task, surfacing the
 * least-irrelevant entry is worse than surfacing none, because the agent reads
 * whatever it's given as though it mattered.
 */
export function retrieveForTask(
  entries: Array<{ id: string; text: string }>,
  task: string,
  opts: RetrieveOpts = {},
): ScoredEntry[] {
  const weight = opts.recurrenceWeight ?? RECURRENCE_WEIGHT;
  const minScore = opts.minScore ?? 0;

  const idf = buildIdf(entries.map((e) => e.text));
  const taskTerms = tokens(task);

  // Recurrence bonus is computed over the pooled corpus so a theme that recurs
  // across both corrections and attempts still counts.
  const pooled = entries.map((e) => e.text).join("\n\n---\n\n");
  const sizes = clusterSizes(pooled);

  return entries
    .map((e) => {
      const relevance = relevanceScore(taskTerms, e.text, idf);
      // log so a 10× cluster doesn't dwarf relevance outright — recurrence
      // breaks ties and lifts near-misses, it doesn't override the task.
      const recurrence = Math.log(1 + (sizes.get(e.id) ?? 1));
      return { id: e.id, text: e.text, score: relevance + weight * recurrence };
    })
    .filter((e) => e.score > minScore)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Convenience for callers holding raw markdown rather than split entries. */
export function retrieveFromRaw(
  raw: string,
  task: string,
  opts: RetrieveOpts = {},
): ScoredEntry[] {
  const entries = splitEntries(raw)
    .map((text) => ({ id: entryId(text) ?? "", text }))
    .filter((e) => e.id);
  return retrieveForTask(entries, task, opts);
}
