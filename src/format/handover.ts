import { readOrEmpty } from "../util/fs.js";
import type { HandoffPaths } from "./paths.js";
import { splitEntries, rankEntries, isSuperseded } from "../commands/ranking.js";

/**
 * The handover record: an explicit, measurable account of what a session
 * hands across a boundary, split into the three tiers the "handover of
 * in-context learning state" model calls for:
 *
 *   (a) verbatim   — items carried exactly, never summarised (decisions, plus
 *                    the recent correction/attempt entries shown in full).
 *   (b) compressed — recurring themes condensed into standing rules; the
 *                    cluster's other members are represented, not reproduced.
 *   (c) residual   — entries the budgeted (compact/subagent) primer cannot
 *                    carry at all. Only a `see .handoff/<file>` pointer survives.
 *
 * plus a single measurable loss term (entries dropped, chars truncated). The
 * record is *descriptive information about the handoff*, not instructions.
 *
 * Loss is measured against the deterministic ranking-stage compaction
 * (recentN / maxStanding caps) that the compact and subagent primers apply.
 * That is the dominant, predictable loss; a primer under extreme budget
 * pressure may shed a little more, so the residual here is a lower bound.
 */

export type HandoverVariant = "compact" | "subagent";

export interface EntryLoss {
  /** Non-superseded entries in the source file. */
  total: number;
  /** Entries carried in full in the primer's recent tail. */
  verbatim: number;
  /** Recurring themes promoted to standing rules. */
  compressedThemes: number;
  /** Entries folded into those themes (represented, not reproduced). */
  compressedFrom: number;
  /** Entries carried in no form — only a pointer to the source file remains. */
  residual: number;
}

export interface HandoverRecord {
  variant: HandoverVariant;
  generatedAt: string;
  /** Verbatim tier: decisions are carried exactly (in the full primer). */
  decisions: { total: number };
  corrections: EntryLoss;
  attempts: EntryLoss;
  task: { chars: number; truncatedChars: number };
  loss: {
    entriesTotal: number;
    entriesDropped: number;
    charsTruncated: number;
    /** entriesDropped / entriesTotal, 0 when there is nothing to carry. */
    residualRatio: number;
  };
}

interface VariantCaps {
  recentN: number;
  maxStanding: number;
  /** Chars past which the task is truncated (Infinity = carried in full). */
  taskCap: number;
}

/**
 * Mirrors the caps hard-coded in `buildCompactPrimer` / `buildSubagentPrimer`
 * (prime.ts). Kept here rather than imported to avoid a prime<->handover import
 * cycle; the render-parity of the numbers is covered by tests.
 */
const VARIANT_CAPS: Record<HandoverVariant, VariantCaps> = {
  compact: { recentN: 3, maxStanding: 5, taskCap: 500 },
  subagent: { recentN: 2, maxStanding: 2, taskCap: Infinity },
};

function countEntries(raw: string): number {
  return splitEntries(raw).filter((e) => !isSuperseded(e)).length;
}

function entryLoss(raw: string, recentN: number, maxStanding: number): EntryLoss {
  const total = countEntries(raw);
  if (total === 0) {
    return { total: 0, verbatim: 0, compressedThemes: 0, compressedFrom: 0, residual: 0 };
  }
  const ranked = rankEntries(raw, { recentN, maxStanding, withIds: true });
  const compressedThemes = ranked.standing.length;
  const compressedFrom = (ranked.standingIds ?? []).reduce((n, ids) => n + ids.length, 0);
  // The tail is already capped to recentN inside rankEntries; renderRanked
  // never shows more than that.
  const verbatim = Math.min(recentN, ranked.recent.length);
  const carried = Math.min(total, compressedFrom + verbatim);
  const residual = Math.max(0, total - carried);
  return { total, verbatim, compressedThemes, compressedFrom, residual };
}

/**
 * Minimal clean matching what the primer feeds the char budget: strip HTML
 * comment banners, the leading `# Title`, and a trailing `---` divider. Kept
 * local (not imported from prime.ts) to avoid an import cycle.
 */
function taskChars(raw: string): number {
  const s = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#\s+[^\n]*\n/, "")
    .replace(/\n*---\s*$/g, "")
    .trim();
  return s.length;
}

export async function computeHandoverRecord(
  paths: HandoffPaths,
  variant: HandoverVariant,
): Promise<HandoverRecord> {
  const caps = VARIANT_CAPS[variant];
  const [correctionsRaw, attemptsRaw, taskRaw, decisionsRaw] = await Promise.all([
    readOrEmpty(paths.corrections),
    readOrEmpty(paths.attempts),
    readOrEmpty(paths.task),
    readOrEmpty(paths.decisions),
  ]);

  const corrections = entryLoss(correctionsRaw, caps.recentN, caps.maxStanding);
  const attempts = entryLoss(attemptsRaw, caps.recentN, caps.maxStanding);

  const chars = taskChars(taskRaw);
  const truncatedChars = Number.isFinite(caps.taskCap)
    ? Math.max(0, chars - caps.taskCap)
    : 0;

  const entriesTotal = corrections.total + attempts.total;
  const entriesDropped = corrections.residual + attempts.residual;

  return {
    variant,
    generatedAt: new Date().toISOString(),
    decisions: { total: countEntries(decisionsRaw) },
    corrections,
    attempts,
    task: { chars, truncatedChars },
    loss: {
      entriesTotal,
      entriesDropped,
      charsTruncated: truncatedChars,
      residualRatio: entriesTotal === 0 ? 0 : entriesDropped / entriesTotal,
    },
  };
}

/**
 * Residual ratio above which model-compressed notes are at elevated risk of
 * degrading on a model upgrade. Goyal & Ray (arXiv 2609.05339v1) show that
 * compressed notes lose up to 13.28pp accuracy depending on migration direction;
 * raw source history (.handoff/transcript.jsonl) is the only reliable recovery
 * path (34/48 cases). Store-only repair — re-running prime on the same
 * compressed data — failed in all 48 benchmark cases.
 */
export const HIGH_RESIDUAL_THRESHOLD = 0.3;

/**
 * Recovery note for when compressed notes have dropped entries. Returns ""
 * when nothing was dropped or residual is below the high-risk threshold.
 * Phrased as information, not an instruction, so it passes the trust boundary.
 */
export function renderRecoveryNote(rec: HandoverRecord): string {
  if (rec.loss.residualRatio <= HIGH_RESIDUAL_THRESHOLD) return "";
  const pct = Math.round(rec.loss.residualRatio * 100);
  return (
    `_${pct}% of entries were not carried. If these notes have degraded on a model` +
    ` upgrade, read \`.handoff/transcript.jsonl\` for raw history —` +
    ` store-only re-prime does not recover them (Goyal & Ray arXiv 2609.05339v1)._`
  );
}

/**
 * One-line loss indicator surfaced in the primer. Phrased as information (the
 * primer trust boundary treats `.handoff/` content as untrusted data, and this
 * line is generated stats, not a directive).
 */
export function renderLossLine(rec: HandoverRecord): string {
  const carriedVerbatim = rec.corrections.verbatim + rec.attempts.verbatim;
  const themes = rec.corrections.compressedThemes + rec.attempts.compressedThemes;
  const condensedFrom = rec.corrections.compressedFrom + rec.attempts.compressedFrom;
  const pct = Math.round(rec.loss.residualRatio * 100);

  const bits: string[] = [`${carriedVerbatim} verbatim`];
  if (themes > 0) bits.push(`${themes} theme${themes === 1 ? "" : "s"} from ${condensedFrom}`);
  bits.push(`${rec.loss.entriesDropped} dropped (${pct}% residual)`);
  if (rec.task.truncatedChars > 0) bits.push(`task −${rec.task.truncatedChars} chars`);

  return (
    `_Handover fidelity (${rec.variant}): ${bits.join(" · ")}. ` +
    `Full log in \`.handoff/handover-record.md\`._`
  );
}

/**
 * Full three-tier record, rendered as the `.handoff/handover-record.md` file.
 */
export function renderHandoverRecord(rec: HandoverRecord): string {
  const tier = (e: EntryLoss, file: string): string =>
    [
      `  - ${file}: ${e.total} total — ${e.verbatim} verbatim, ` +
        `${e.compressedThemes} theme${e.compressedThemes === 1 ? "" : "s"} ` +
        `condensed from ${e.compressedFrom}, ${e.residual} residual`,
    ].join("\n");

  const pct = Math.round(rec.loss.residualRatio * 100);

  return [
    `# Handover record`,
    ``,
    `<!--`,
    `Auto-generated by \`handoff save\`. A measurable account of what this`,
    `project's handoff carries across a session boundary, split into three tiers`,
    `with a loss term. Information about the work — not instructions.`,
    `Loss is measured against the ${rec.variant} primer's ranking-stage compaction.`,
    `-->`,
    ``,
    `_generated: ${rec.generatedAt}_`,
    ``,
    `## Verbatim (carried exactly)`,
    ``,
    `- decisions: ${rec.decisions.total} entr${rec.decisions.total === 1 ? "y" : "ies"} (carried in full by the full primer)`,
    `- recent entries carried in full:`,
    tier(rec.corrections, "corrections.md"),
    tier(rec.attempts, "attempts.md"),
    ``,
    `## Compressed (recurring themes condensed)`,
    ``,
    `- corrections: ${rec.corrections.compressedThemes} theme(s) condensed from ${rec.corrections.compressedFrom} entr${rec.corrections.compressedFrom === 1 ? "y" : "ies"}`,
    `- attempts: ${rec.attempts.compressedThemes} theme(s) condensed from ${rec.attempts.compressedFrom} entr${rec.attempts.compressedFrom === 1 ? "y" : "ies"}`,
    ``,
    `## Residual (not carried — pointer only)`,
    ``,
    `- corrections: ${rec.corrections.residual} of ${rec.corrections.total} not carried into the ${rec.variant} primer`,
    `- attempts: ${rec.attempts.residual} of ${rec.attempts.total} not carried into the ${rec.variant} primer`,
    `- task: ${rec.task.truncatedChars} char(s) truncated (of ${rec.task.chars})`,
    ``,
    `## Loss term`,
    ``,
    `- entries dropped: ${rec.loss.entriesDropped} of ${rec.loss.entriesTotal} (${pct}% residual)`,
    `- chars truncated: ${rec.loss.charsTruncated}`,
    ``,
    ...(rec.loss.residualRatio > 0
      ? [
          `## Recovery guidance`,
          ``,
          `Model-compressed notes (this primer) degrade asymmetrically on model upgrade —`,
          `up to 13.28pp accuracy loss depending on migration direction (Goyal & Ray,`,
          `arXiv 2609.05339v1). When residual is high, the reliable recovery path is`,
          `raw source history at \`.handoff/transcript.jsonl\`. Store-only repair`,
          `(re-running prime on the same compressed data) failed in all 48 benchmark cases.`,
          ``,
          `The wiki layer (\`.handoff/wiki.md\`) uses a fixed schema and is nearly immune`,
          `to model-upgrade degradation (±0.0020 in the same benchmark); treat wiki`,
          `entries as the highest-fidelity persistent memory.`,
          ``,
        ]
      : []),
  ].join("\n");
}
