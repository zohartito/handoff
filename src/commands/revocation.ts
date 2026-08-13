import { isSuperseded } from "./ranking.js";

/**
 * Keyed, revocable memory precedents.
 *
 * Append-only logs have a falsifiability problem: when a fact changes ("deploy
 * target is staging" → "deploy target is prod"), the stale entry stays
 * retrievable and pollutes the primer. TEPA (arXiv:2608.07429) measures the
 * damage — under fact drift, append-only memory scores *below no memory at
 * all* (0.210 vs 0.309; keyed revocation 0.950) — and shows that same-key
 * replacement with an explicit revoked state is the decisive operation.
 *
 * The adaptation here is deliberately minimal: an entry may carry a
 * `**key:** <key>` field naming the fact it asserts. Logging a new entry under
 * a key revokes older *active* entries with the same key by annotating them in
 * place (`**superseded:** true` + `**revoked-by:**`/`**revoked-at:**`).
 * Nothing is deleted — revoked entries keep their full text in the file for
 * audit, and `isSuperseded` (which predates this producer) hides them from
 * ranking and retrieval. Re-promotion needs no machinery: re-asserting an old
 * value under the same key simply creates a fresh active entry.
 *
 * TEPA's support/conflict counters and trial-validated promotion are dropped
 * on purpose — they exist to score noisy observational evidence, while these
 * logs record deliberate statements; the paper's own ablation attributes the
 * whole effect to revocation.
 */

/** Canonical form of a fact key: case- and whitespace-insensitive. */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The normalized `**key:** <key>` field of an entry, or null if unkeyed. */
export function entryKey(entry: string): string | null {
  const m = entry.match(/^\*\*key:\*\*\s*(.+?)\s*$/im);
  return m && m[1] ? normalizeKey(m[1]) : null;
}

export interface RevocationResult {
  /** The full document with revocation markers inserted. */
  updated: string;
  /** Ids (`## <timestamp>` headers) of newly revoked entries, oldest first. */
  revokedIds: string[];
}

/**
 * Mark every active entry asserting `key` as revoked by `revokedBy`.
 *
 * Pure text transform over a whole log document, meant to run under the same
 * file lock as the append of the revoking entry (which is why `revokedBy`
 * entries already present are left alone). Markers are inserted directly under
 * the entry's `## ` header; the entry's own text is never touched, so the
 * history stays auditable. Already-revoked entries keep their original
 * `revoked-by` provenance rather than being restamped.
 */
export function revokeActiveByKey(
  raw: string,
  key: string,
  revokedBy: string,
  revokedAt: string,
): RevocationResult {
  const want = normalizeKey(key);
  const lines = raw.split("\n");
  const headers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) headers.push(i);
  }

  const revokedIds: string[] = [];
  // Walk newest-first so splices never shift the indices still to visit.
  for (let h = headers.length - 1; h >= 0; h--) {
    const start = headers[h]!;
    const end = h + 1 < headers.length ? headers[h + 1]! : lines.length;
    const block = lines.slice(start, end).join("\n");
    const id = block.match(/^##\s+(.+?)\s*$/m)?.[1]?.trim() ?? null;
    if (id === revokedBy) continue;
    if (entryKey(block) !== want) continue;
    if (isSuperseded(block)) continue;
    lines.splice(
      start + 1,
      0,
      "",
      "**superseded:** true",
      `**revoked-by:** ${revokedBy}`,
      `**revoked-at:** ${revokedAt}`,
    );
    if (id) revokedIds.push(id);
  }

  revokedIds.reverse();
  return { updated: lines.join("\n"), revokedIds };
}
