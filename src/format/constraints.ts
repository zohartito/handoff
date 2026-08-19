import { splitEntries, isSuperseded, entryId } from "../commands/ranking.js";

/**
 * Constraint-preserving compaction.
 *
 * When a session's context is compacted, the rules the user actually stated —
 * "always prefer pathlib", "never commit secrets", "surgical diffs only" — are
 * the first thing that should survive and the easiest thing to lose: a summariser
 * keeps the gist and drops the guardrail. handoff's own budgeted primers
 * (compact / subagent) are a compaction step with exactly this failure mode:
 * `renderRanked` keeps only the latest N corrections, and `shedToBudget` can drop
 * whole correction sections, so a one-off constraint older than the window is
 * silently gone.
 *
 * The fix is deterministic, not model-mediated: extract every user constraint
 * from `corrections.md` up front, re-inject them verbatim into the compacted
 * primer as a block that compaction is not allowed to shed, and verify after the
 * fact that none went missing.
 */

export interface Constraint {
  /** The entry's `## <timestamp>` id, when it has one. */
  id: string | null;
  /** The constraint text, taken verbatim from the file (never summarised). */
  text: string;
}

/**
 * The rule an entry encodes: what the user said, or the distilled lesson. These
 * are the durable, user-authored guardrails — as opposed to `**agent did:**`,
 * which records the mistake, not the rule. Returns the clause verbatim.
 */
function pickRule(entry: string): string | null {
  const m =
    entry.match(/^\*\*user said:\*\*\s*(.+)$/im) ??
    entry.match(/^\*\*lesson:\*\*\s*(.+)$/im);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Extract every distinct user constraint from a corrections log, in file order.
 * Superseded entries (retired via keyed revocation) are skipped; duplicates are
 * de-duped on exact text so a restated rule appears once.
 */
export function extractConstraints(correctionsRaw: string): Constraint[] {
  const entries = splitEntries(correctionsRaw).filter((e) => !isSuperseded(e));
  const out: Constraint[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const text = pickRule(entry);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ id: entryId(entry), text });
  }
  return out;
}

/** Heading of the re-injected verbatim block; also its shed-protection marker. */
export const CONSTRAINTS_HEADING = "## User constraints (carried verbatim — never summarized)";

/**
 * Render the extracted constraints as a primer section. Returns "" when there
 * are none, so callers can push it unconditionally without emitting an empty
 * heading.
 */
export function renderConstraintsBlock(constraints: Constraint[]): string {
  if (constraints.length === 0) return "";
  const lines = constraints.map((c) => `- ${c.text}`).join("\n");
  return `${CONSTRAINTS_HEADING}\n\n${lines}`;
}

/**
 * Post-compaction check: every extracted constraint must appear verbatim in the
 * produced primer. `missing` is non-empty only when compaction failed to carry a
 * guardrail — the exact failure this feature exists to catch. Callers surface it
 * loudly rather than letting a dropped rule pass silently.
 */
export function verifyConstraintsPreserved(
  primer: string,
  constraints: Constraint[],
): { ok: boolean; missing: Constraint[] } {
  const missing = constraints.filter((c) => !primer.includes(c.text));
  return { ok: missing.length === 0, missing };
}
