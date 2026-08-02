/**
 * Shared markdown tokenizer: unigrams + bigrams with stopword filtering.
 *
 * Used by two callers with different axes:
 * - `commands/patterns.ts` aggregates these across projects to surface
 *   cross-project correction themes.
 * - `commands/ranking.ts` counts them per-entry within one file to decide
 *   which corrections have recurred often enough to be standing rules.
 *
 * Extracted here so both share one definition of "what counts as a word".
 */

/** Small inline English stopword list. ~50 words — enough to strip the worst noise. */
export const STOPWORDS: ReadonlySet<string> = new Set<string>([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "else",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done", "doing",
  "have", "has", "had", "having",
  "i", "you", "he", "she", "it", "we", "they", "them", "us", "me",
  "my", "your", "his", "her", "its", "our", "their",
  "this", "that", "these", "those",
  "to", "of", "in", "on", "at", "for", "with", "by", "from", "as",
  "not", "no", "yes",
  "will", "would", "should", "could", "can", "may", "might", "must",
  "just", "than", "too", "very", "also", "about",
]);

/**
 * Tokenize markdown into unigram + bigram counts.
 *
 * Skips headings, list bullets, numbered items and `---` rules; strips inline
 * code and emphasis so we don't tokenize punctuation. Drops tokens of length
 * <= 2, pure digits, and stopwords.
 */
export function extractNgrams(
  md: string,
  opts: { includeListLines?: boolean } = {},
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!md) return counts;

  // Callers that tokenize prose written *by* someone (a restatement, an open
  // loop) must keep list lines: skipping them silently discards the entire
  // content of any answer written as a numbered or bulleted list. Only the
  // cross-project theme scan wants them dropped as low-signal structure.
  const keepLists = opts.includeListLines === true;

  // Comment banners are boilerplate shipped in every template — tokenizing them
  // manufactures identical "themes" in every project.
  const body = md.replace(/<!--[\s\S]*?-->/g, " ");

  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (/^[-*+]\s/.test(line) || /^\d+[.)]\s/.test(line)) {
      if (!keepLists) continue;
      // Strip the marker (and any checkbox) so it doesn't pollute the tokens.
      line = line.replace(/^([-*+]|\d+[.)])\s+/, "").replace(/^\[[ xX]?\]\s*/, "");
      if (!line) continue;
    }
    if (line.startsWith("---")) continue;
    // Strip markdown emphasis and inline code fences so we don't tokenize asterisks.
    const stripped = line
      .replace(/`[^`]*`/g, " ")
      .replace(/\*\*/g, " ")
      .replace(/[*_]/g, " ");

    const tokens = stripped
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));

    for (const t of tokens) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (let i = 0; i < tokens.length - 1; i++) {
      const bi = `${tokens[i]} ${tokens[i + 1]}`;
      counts.set(bi, (counts.get(bi) ?? 0) + 1);
    }
  }
  return counts;
}
