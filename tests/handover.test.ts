import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHandoffPaths } from "../src/format/paths.js";
import {
  computeHandoverRecord,
  renderLossLine,
  renderHandoverRecord,
  renderRecoveryNote,
  HIGH_RESIDUAL_THRESHOLD,
} from "../src/format/handover.js";
import { buildCompactPrimer, buildSubagentPrimer } from "../src/commands/prime.js";
import { save } from "../src/commands/save.js";

function mkCorrection(ts: string, action: string, userSaid: string): string {
  return `\n## ${ts}\n\n**agent did:** ${action}\n\n**user said:** ${userSaid}\n\n---\n`;
}
function mkAttempt(ts: string, what: string, err: string, fix: string): string {
  return `\n## ${ts}\n\n**tried:** ${what}\n\n**error:**\n\n\`\`\`\n${err}\n\`\`\`\n\n**fix:** ${fix}\n\n---\n`;
}

/** Eight distinct, unrelated corrections — no theme recurs, so none is promoted. */
function scaffold(): ReturnType<typeof resolveHandoffPaths> {
  const dir = mkdtempSync(join(tmpdir(), "handoff-handover-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);

  writeFileSync(paths.task, "# Task\n\nBuild the handover record.\n");
  const corrections = [
    mkCorrection("2026-01-01T00:00:00Z", "wrote a readme", "never generate markdown unprompted"),
    mkCorrection("2026-01-02T00:00:00Z", "changed the python runtime", "keep runtimes fixed"),
    mkCorrection("2026-01-03T00:00:00Z", "used tabs", "spaces only in this repo"),
    mkCorrection("2026-01-04T00:00:00Z", "committed a secret key", "never commit credentials"),
    mkCorrection("2026-01-05T00:00:00Z", "renamed the public export", "keep the api stable"),
    mkCorrection("2026-01-06T00:00:00Z", "added a docker file", "no containers for local scripts"),
    mkCorrection("2026-01-07T00:00:00Z", "reformatted unrelated files", "surgical diffs only"),
    mkCorrection("2026-01-08T00:00:00Z", "swapped the color palette", "match the existing theme"),
  ].join("");
  writeFileSync(paths.corrections, `# Corrections\n${corrections}`);
  writeFileSync(paths.attempts, "# Attempts\n");
  writeFileSync(paths.decisions, `# Decisions\n\n## 2026-01-01T00:00:00Z\n\n**chose:** node\n\n**because:** npm\n\n---\n`);
  return paths;
}

test("computeHandoverRecord splits state into verbatim / compressed / residual", async () => {
  const paths = scaffold();
  const rec = await computeHandoverRecord(paths, "compact");

  assert.equal(rec.corrections.total, 8);
  // compact keeps the latest 3 verbatim; none of the 8 unrelated entries clusters.
  assert.equal(rec.corrections.verbatim, 3);
  assert.equal(rec.corrections.compressedThemes, 0);
  // 8 total − 3 carried verbatim = 5 residual.
  assert.equal(rec.corrections.residual, 5);
  // decisions are the verbatim tier carried by the full primer.
  assert.equal(rec.decisions.total, 1);
});

test("loss term counts dropped entries and computes a residual ratio", async () => {
  const rec = await computeHandoverRecord(scaffold(), "compact");
  assert.equal(rec.loss.entriesTotal, 8);
  assert.equal(rec.loss.entriesDropped, 5);
  assert.ok(Math.abs(rec.loss.residualRatio - 5 / 8) < 1e-9);
});

test("subagent variant carries less and reports higher residual than compact", async () => {
  const paths = scaffold();
  const compact = await computeHandoverRecord(paths, "compact");
  const subagent = await computeHandoverRecord(paths, "subagent");
  // subagent keeps only the latest 2 verbatim vs. 3 for compact.
  assert.equal(subagent.corrections.verbatim, 2);
  assert.ok(subagent.loss.entriesDropped > compact.loss.entriesDropped);
});

test("empty logs produce a zero-loss record with no divide-by-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-handover-empty-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.task, "# Task\n\nnothing yet\n");
  const rec = await computeHandoverRecord(paths, "compact");
  assert.equal(rec.loss.entriesTotal, 0);
  assert.equal(rec.loss.entriesDropped, 0);
  assert.equal(rec.loss.residualRatio, 0);
});

test("task truncation is measured for the compact variant only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-handover-task-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.task, `# Task\n\n${"x".repeat(700)}\n`);
  writeFileSync(paths.corrections, "# Corrections\n");
  writeFileSync(paths.attempts, "# Attempts\n");

  const compact = await computeHandoverRecord(paths, "compact");
  assert.equal(compact.task.truncatedChars, 700 - 500);

  const subagent = await computeHandoverRecord(paths, "subagent");
  // subagent carries the full task, so nothing is truncated.
  assert.equal(subagent.task.truncatedChars, 0);
});

test("loss line is one line, phrased as information not instructions", async () => {
  const rec = await computeHandoverRecord(scaffold(), "compact");
  const line = renderLossLine(rec);
  assert.ok(!line.includes("\n"), "loss line must be a single line");
  assert.match(line, /Handover fidelity \(compact\)/);
  assert.match(line, /5 dropped/);
  assert.match(line, /63% residual/);
});

test("compact primer surfaces the handover fidelity footer within budget", async () => {
  const out = await buildCompactPrimer(scaffold(), "claude-code");
  assert.match(out, /## Handover fidelity/);
  assert.match(out, /Handover fidelity \(compact\)/);
  assert.ok(out.length < 2000, `compact primer with footer too long: ${out.length}`);
});

test("subagent primer surfaces the handover fidelity footer within budget", async () => {
  const out = await buildSubagentPrimer(scaffold(), "claude-code");
  assert.match(out, /## Handover fidelity/);
  assert.match(out, /Handover fidelity \(subagent\)/);
  assert.ok(out.length < 2000, `subagent primer with footer too long: ${out.length}`);
});

test("renderHandoverRecord names all three tiers and the loss term", async () => {
  const rec = await computeHandoverRecord(scaffold(), "compact");
  const doc = renderHandoverRecord(rec);
  assert.match(doc, /## Verbatim/);
  assert.match(doc, /## Compressed/);
  assert.match(doc, /## Residual/);
  assert.match(doc, /## Loss term/);
});

test("renderRecoveryNote returns empty string when residualRatio is 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-recovery-empty-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.task, "# Task\n\nnothing\n");
  writeFileSync(paths.corrections, "# Corrections\n");
  writeFileSync(paths.attempts, "# Attempts\n");
  const rec = await computeHandoverRecord(paths, "compact");
  assert.equal(rec.loss.residualRatio, 0);
  assert.equal(renderRecoveryNote(rec), "");
});

test("renderRecoveryNote returns empty string when residualRatio is at or below threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-recovery-low-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  // 3 corrections: compact keeps latest 3 verbatim → 0 residual → ratio 0
  writeFileSync(
    paths.corrections,
    [
      mkCorrection("2026-01-01T00:00:00Z", "did x", "rule one"),
      mkCorrection("2026-01-02T00:00:00Z", "did y", "rule two"),
      mkCorrection("2026-01-03T00:00:00Z", "did z", "rule three"),
    ].join(""),
  );
  writeFileSync(paths.attempts, "# Attempts\n");
  writeFileSync(paths.task, "# Task\n\nsmall\n");
  const rec = await computeHandoverRecord(paths, "compact");
  // 3 corrections, compact recentN=3, so all fit verbatim → residual=0 → ratio=0
  assert.ok(rec.loss.residualRatio <= HIGH_RESIDUAL_THRESHOLD);
  assert.equal(renderRecoveryNote(rec), "");
});

test("renderRecoveryNote returns a note citing transcript.jsonl when residualRatio > threshold", async () => {
  const rec = await computeHandoverRecord(scaffold(), "compact");
  // scaffold has 8 corrections, compact keeps 3 → residualRatio = 5/8 = 0.625 > 0.3
  assert.ok(rec.loss.residualRatio > HIGH_RESIDUAL_THRESHOLD);
  const note = renderRecoveryNote(rec);
  assert.ok(note.length > 0, "note must be non-empty for high residual");
  assert.ok(note.includes("transcript.jsonl"), "must point to raw history");
  assert.ok(note.includes("2609.05339"), "must cite the paper");
});

test("renderHandoverRecord includes Recovery guidance section when residual > 0", async () => {
  const rec = await computeHandoverRecord(scaffold(), "compact");
  assert.ok(rec.loss.residualRatio > 0);
  const doc = renderHandoverRecord(rec);
  assert.match(doc, /## Recovery guidance/);
  assert.match(doc, /transcript\.jsonl/);
  assert.match(doc, /2609\.05339/);
  assert.match(doc, /wiki\.md/);
});

test("renderHandoverRecord omits Recovery guidance section when residual is 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-recovery-zero-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.task, "# Task\n\nnothing\n");
  writeFileSync(paths.corrections, "# Corrections\n");
  writeFileSync(paths.attempts, "# Attempts\n");
  const rec = await computeHandoverRecord(paths, "compact");
  const doc = renderHandoverRecord(rec);
  assert.ok(!doc.includes("Recovery guidance"), "no recovery section when nothing was dropped");
});

test("save writes .handoff/handover-record.md", async () => {
  const paths = scaffold();
  await save({ cwd: paths.root });
  assert.ok(existsSync(paths.handoverRecord), "handover-record.md must exist after save");
  const doc = readFileSync(paths.handoverRecord, "utf8");
  assert.match(doc, /# Handover record/);
  assert.match(doc, /Residual/);
});
