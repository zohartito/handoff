import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCorrections, detectSessionConstraints } from "../src/commands/auto-capture.js";
import { hook } from "../src/commands/hook.js";
import { buildCompactPrimer } from "../src/commands/prime.js";
import { resolveHandoffPaths } from "../src/format/paths.js";
import type { ParsedSession } from "../src/commands/ingest.js";

const here = dirname(fileURLToPath(import.meta.url));
const CASES = resolve(here, "../../tests/fixtures/session-constraints/cases.json");

type Case = { index: number; text: string; constraints: string[] };
const cases: Case[] = JSON.parse(readFileSync(CASES, "utf8")).cases;

function sessionOf(c: Case): ParsedSession {
  return {
    sessionId: null, file: "x", cwd: null, firstTs: null, lastTs: null,
    userMsgs: [], assistantTurns: [], errors: [], toolCounts: {},
    filesTouched: new Set(), bashCommands: [], bashCalls: [],
    userTurns: [{ ts: "2026-05-01T09:00:00Z", text: c.text, index: c.index, precedingAssistant: "did a thing" }],
    startLine: 0, linesProcessed: 0,
  };
}

test("fixture is a real labelled set: 40+ turns, 20+ constraints (some in a first message), 20+ non-constraints", () => {
  const pos = cases.filter((c) => c.constraints.length > 0);
  assert.ok(cases.length >= 40);
  assert.ok(pos.length >= 20);
  assert.ok(cases.length - pos.length >= 20);
  assert.ok(pos.some((c) => c.index === 0 && c.text.length > c.constraints[0]!.length + 20));
});

test("detectSessionConstraints: recall >= 0.80, precision >= 0.90, well above the detectCorrections baseline", () => {
  // Candidate, scored strictly: an extracted sentence counts only if it is a
  // labelled constraint VERBATIM.
  let expected = 0, extracted = 0, hit = 0;
  // Baseline, scored generously at turn level: detectCorrections cannot pick a
  // sentence, so any flag on a constraint turn counts as a hit.
  let bTP = 0, bFP = 0;
  for (const c of cases) {
    const got = detectSessionConstraints(sessionOf(c)).map((x) => x.text);
    expected += c.constraints.length;
    extracted += got.length;
    hit += got.filter((g) => c.constraints.includes(g)).length;
    const flagged = detectCorrections(sessionOf(c)).length > 0;
    if (flagged && c.constraints.length > 0) bTP++;
    if (flagged && c.constraints.length === 0) bFP++;
  }
  const positives = cases.filter((c) => c.constraints.length > 0).length;
  const recall = hit / expected;
  const precision = extracted === 0 ? 0 : hit / extracted;
  const baseRecall = bTP / positives;
  const basePrecision = bTP + bFP === 0 ? 0 : bTP / (bTP + bFP);
  console.log(
    `session-constraints: candidate recall=${recall.toFixed(3)} precision=${precision.toFixed(3)} | ` +
      `detectCorrections baseline recall=${baseRecall.toFixed(3)} precision=${basePrecision.toFixed(3)}`,
  );
  assert.ok(recall >= 0.8, `recall ${recall}`);
  assert.ok(precision >= 0.9, `precision ${precision}`);
  assert.ok(recall >= baseRecall + 0.5, `recall ${recall} vs baseline ${baseRecall}`);
});

test("pre-compact hook logs a rule from the first message verbatim and the compact primer carries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-sessconst-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  const rule = "Confirm with me before you edit or delete any event.";
  const t = "2026-05-01T09:00:00.000Z";
  const file = join(dir, "s.jsonl");
  writeFileSync(
    file,
    [
      { type: "user", timestamp: t, sessionId: "s", message: { role: "user", content: `Help me clean up my calendar for next week. ${rule}` } },
      { type: "assistant", timestamp: t, sessionId: "s", message: { role: "assistant", content: [{ type: "text", text: "Looking at your calendar." }] } },
      { type: "user", timestamp: t, sessionId: "s", message: { role: "user", content: "Start with Monday." } },
    ].map((o) => JSON.stringify(o)).join("\n") + "\n",
  );
  try {
    const payload = { transcript_path: file, session_id: "s", hook_event_name: "PreCompact" };
    await hook({ event: "pre-compact", cwd: dir, payload });
    const corrections = readFileSync(paths.corrections, "utf8");
    assert.ok(corrections.includes(`**user said:** ${rule}`), corrections);
    assert.ok((await buildCompactPrimer(paths, "generic")).includes(rule));

    await hook({ event: "pre-compact", cwd: dir, payload });
    assert.equal(readFileSync(paths.corrections, "utf8"), corrections, "re-run is a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
