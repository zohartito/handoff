import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrimer,
  buildCompactPrimer,
  buildSubagentPrimer,
  lastNEntries,
  splitEntries,
  COMPACT_THRESHOLD,
} from "../src/commands/prime.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

/**
 * Build a realistic `.handoff/` in a temp dir and return its paths.
 * "Average-populated" = a real task, some open loops, 5 corrections,
 * 5 attempts, an auto-generated environment block.
 */
function scaffoldRealisticHandoff(): ReturnType<typeof resolveHandoffPaths> {
  const dir = mkdtempSync(join(tmpdir(), "handoff-prime-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);

  writeFileSync(paths.meta, JSON.stringify({
    schemaVersion: 1,
    sourceTool: "claude-code",
    sourceVersion: null,
    createdAt: "2026-04-16T10:00:00Z",
    updatedAt: "2026-04-16T12:00:00Z",
    projectRoot: dir,
  }, null, 2));

  writeFileSync(paths.task, `# Task

## Goal

Build a portable session-state CLI so users can hand off mid-task between Claude Code, Cursor, Codex, and Gemini.

## Done looks like

- \`handoff prime\` emits a primer that another tool can ingest
- No loss of task / attempts / corrections across the switch
`);

  writeFileSync(paths.openLoops, `# Open Loops

- Need to decide: should \`switch\` auto-launch the new tool or just copy primer to clipboard?
- Waiting on: user's preference on codex auth flow
`);

  // 5 correction entries — we expect compact mode to keep only the last 3.
  const corrections = [
    mkCorrection("2026-04-10T09:00:00Z", "wrote a README unprompted", "stop generating markdown files you weren't asked for"),
    mkCorrection("2026-04-11T10:30:00Z", "switched Python version mid-task", "don't change runtimes without asking"),
    mkCorrection("2026-04-12T14:15:00Z", "used os.path instead of pathlib", "always prefer pathlib"),
    mkCorrection("2026-04-14T16:20:00Z", "added speculative flexibility to the API", "simplest working solution only"),
    mkCorrection("2026-04-15T11:05:00Z", "over-commented obvious code", "comments only where the logic isn't self-evident"),
  ].join("");
  writeFileSync(paths.corrections, `# Corrections\n\n<!-- comment block -->\n${corrections}`);

  // 5 attempt entries — expect last 3 in compact.
  const attempts = [
    mkAttempt("2026-04-10T09:15:00Z", "pegged the SQLite version to 3.41", "version mismatch on CI", "bumped to node 22+ which bundles SQLite"),
    mkAttempt("2026-04-11T11:00:00Z", "used a single regex for all three adapters", "cursor adapter failed on composer id", "split into per-adapter normalizers"),
    mkAttempt("2026-04-12T15:00:00Z", "called fs.readFile synchronously in cli init", "blocked the event loop under hook mode", "switched to async readFile"),
    mkAttempt("2026-04-14T17:00:00Z", "tried to detect tool from cwd alone", "false positives when nested", "require explicit --from flag"),
    mkAttempt("2026-04-15T12:00:00Z", "parsed attempts.md with a naive split on lines", "broke on multi-line error traces", "split on ## H2 headers instead"),
  ].join("");
  writeFileSync(paths.attempts, `# Attempts\n\n<!-- header -->\n${attempts}`);

  writeFileSync(paths.environment, `# Environment

<!-- auto-managed section -->

## Auto

- **OS:** linux (x86_64)
- **Node:** 22.11.0
- **Git branch:** main
- **Git status:** clean

## Human notes

- Dev server runs on :3000
`);

  // Keep these present but trivial — compact mode should drop them entirely.
  writeFileSync(paths.decisions, `# Decisions\n\n<!-- decisions -->\n## chose NodeNext for module resolution\n\n- reason: matches package.json "type": "module"\n`);
  writeFileSync(paths.codebaseMap, `# Codebase Map\n\n<!-- map -->\n- \`src/cli.ts\` — entry point\n`);
  writeFileSync(paths.references, `# References\n\n<!-- refs -->\n- https://nodejs.org/api/test.html\n`);
  writeFileSync(paths.identity, `# Identity\n\n<!-- ident -->\n- Prefers terse, code-first answers.\n`);
  writeFileSync(paths.progress, `# Progress\n\n<!-- prog -->\n## Done\n- scaffolded .handoff/\n`);

  return paths;
}

function mkCorrection(ts: string, action: string, userSaid: string): string {
  return `\n## ${ts}\n\n**agent did:** ${action}\n\n**user said:** ${userSaid}\n\n---\n`;
}

function mkAttempt(ts: string, what: string, err: string, fix: string): string {
  return `\n## ${ts}\n\n**tried:** ${what}\n\n**error:**\n\n\`\`\`\n${err}\n\`\`\`\n\n**fix:** ${fix}\n\n---\n`;
}

test("splitEntries splits attempts.md on ## H2 timestamp headers", () => {
  const raw = `# Attempts\n\n<!-- banner -->\n\n## 2026-01-01T00:00:00Z\n\n**tried:** first\n\n---\n\n## 2026-01-02T00:00:00Z\n\n**tried:** second\n\n---\n`;
  const entries = splitEntries(raw);
  assert.equal(entries.length, 2);
  assert.match(entries[0], /first/);
  assert.match(entries[1], /second/);
});

test("splitEntries falls back to --- separators when no ## headers present", () => {
  const raw = `# Attempts\n\nalpha line\n\n---\n\nbravo line\n\n---\n\ncharlie line\n`;
  const entries = splitEntries(raw);
  assert.equal(entries.length, 3);
  assert.match(entries[0], /alpha/);
  assert.match(entries[2], /charlie/);
});

test("splitEntries returns [] on empty or banner-only input", () => {
  assert.deepEqual(splitEntries(""), []);
  assert.deepEqual(splitEntries("# Attempts\n\n<!-- just a comment -->\n"), []);
});

test("lastNEntries preserves order and drops older entries", () => {
  const raw = `## 2026-01-01T00:00:00Z\n\nfirst\n\n---\n\n## 2026-01-02T00:00:00Z\n\nsecond\n\n---\n\n## 2026-01-03T00:00:00Z\n\nthird\n\n---\n\n## 2026-01-04T00:00:00Z\n\nfourth\n\n---\n`;
  const last3 = lastNEntries(raw, 3);
  assert.equal(last3.length, 3);
  assert.match(last3[0], /second/);
  assert.match(last3[2], /fourth/);
});

test("buildCompactPrimer produces < 2000 chars with realistic fixture", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildCompactPrimer(paths, "generic");
  assert.ok(
    out.length < 2000,
    `compact primer too long: ${out.length} chars >= 2000\n---\n${out}`,
  );
});

test("buildCompactPrimer keeps task body, latest correction, latest attempt", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildCompactPrimer(paths, "generic");

  // Task content present
  assert.match(out, /portable session-state CLI/);
  // Latest correction present (the 5th one)
  assert.match(out, /over-commented obvious code/);
  assert.match(out, /comments only where the logic isn't self-evident/);
  // Latest attempt present (the 5th one)
  assert.match(out, /parsed attempts\.md with a naive split/);
  assert.match(out, /split on ## H2 headers instead/);
  // Open loops present
  assert.match(out, /auto-launch the new tool/);
});

test("buildCompactPrimer drops older corrections and attempts (keeps only last 3)", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildCompactPrimer(paths, "generic");

  // The first correction should be omitted
  assert.doesNotMatch(out, /wrote a README unprompted/);
  // The first attempt should be omitted
  assert.doesNotMatch(out, /pegged the SQLite version to 3\.41/);
  // Pointer should mention remaining count
  assert.match(out, /showing latest 3 of 5/);
  assert.match(out, /\.handoff\/corrections\.md/);
  assert.match(out, /\.handoff\/attempts\.md/);
});

test("buildCompactPrimer drops decisions / codebase-map / references / identity", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildCompactPrimer(paths, "generic");
  assert.doesNotMatch(out, /NodeNext for module resolution/);
  assert.doesNotMatch(out, /src\/cli\.ts.*entry point/);
  assert.doesNotMatch(out, /nodejs\.org\/api\/test/);
  assert.doesNotMatch(out, /Prefers terse/);
});

test("buildCompactPrimer squeezes environment to one line with os/node/branch", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildCompactPrimer(paths, "generic");
  const envHeaderIdx = out.indexOf("## Environment");
  assert.ok(envHeaderIdx >= 0, "compact primer missing ## Environment section");
  const envBlock = out.slice(envHeaderIdx);
  assert.match(envBlock, /os: linux/);
  assert.match(envBlock, /node: 22\.11\.0/);
  assert.match(envBlock, /branch: main/);
  // One-line: no "Human notes" leakage, no bullet points
  assert.doesNotMatch(envBlock, /Human notes/);
  assert.doesNotMatch(envBlock, /Dev server runs on/);
});

test("buildCompactPrimer truncates a long task body with a pointer", async () => {
  const paths = scaffoldRealisticHandoff();
  // Overwrite task.md with something >500 chars
  const longTask = `# Task\n\n${"Need to ship the thing before the demo. ".repeat(50)}`;
  writeFileSync(paths.task, longTask);
  const out = await buildCompactPrimer(paths, "generic");
  assert.match(out, /\(see \.handoff\/task\.md for full\)/);
});

test("codex compact primer contains apply_patch hint", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildCompactPrimer(paths, "codex");
  assert.match(out, /apply_patch/);
  // Also references shell, the other codex-native tool name
  assert.match(out, /`shell`/);
});

test("gemini compact primer contains @-reference hint", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildCompactPrimer(paths, "gemini");
  assert.match(out, /@-reference/);
  // And references run_shell_command, gemini's shell tool name
  assert.match(out, /run_shell_command/);
});

test("codex full primer also carries the apply_patch/shell hint", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildPrimer(paths, "codex", Infinity);
  assert.match(out, /apply_patch/);
  assert.match(out, /Claude Code's `Edit` or `Bash`/);
});

test("gemini full primer references @-reference usage", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildPrimer(paths, "gemini", Infinity);
  assert.match(out, /@\.handoff\/task\.md/);
  assert.match(out, /run_shell_command/);
});

test("COMPACT_THRESHOLD is 2000 and drives the implicit-compact branch", () => {
  assert.equal(COMPACT_THRESHOLD, 2000);
});

test("buildPrimer (full) still emits all sections on the realistic fixture", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildPrimer(paths, "generic", Infinity);
  // Full primer keeps decisions, codebase map, references, identity
  assert.match(out, /## Decisions made/);
  assert.match(out, /## Codebase map/);
  assert.match(out, /## References/);
  assert.match(out, /## Identity/);
  // And all 5 corrections/attempts survive
  assert.match(out, /wrote a README unprompted/);
  assert.match(out, /pegged the SQLite version to 3\.41/);
});

// -- rate-limit protocol section -------------------------------------------

test("buildPrimer (full) includes rate-limit protocol section just after the preamble", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildPrimer(paths, "claude-code", Infinity);
  assert.match(out, /## Rate-limit protocol/);
  // Positioning: rate-limit section must land before the Task section.
  const rateIdx = out.indexOf("## Rate-limit protocol");
  const taskIdx = out.indexOf("## Task");
  assert.ok(rateIdx > 0 && taskIdx > rateIdx, "rate-limit section must come before ## Task");
  // Tells the agent the signals to watch for and the commands to run.
  assert.match(out, /rate limit/);
  assert.match(out, /429/);
  assert.match(out, /handoff correct "hit rate limit on claude-code"/);
  assert.match(out, /handoff switch codex/);
});

test("buildPrimer rate-limit recommends claude-code as fallback when current tool is codex", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildPrimer(paths, "codex", Infinity);
  assert.match(out, /handoff switch claude-code/);
  assert.match(out, /handoff correct "hit rate limit on codex"/);
});

test("buildCompactPrimer includes a shorter rate-limit section before Task", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildCompactPrimer(paths, "claude-code");
  assert.match(out, /## Rate-limit protocol/);
  const rateIdx = out.indexOf("## Rate-limit protocol");
  const taskIdx = out.indexOf("## Task");
  assert.ok(rateIdx > 0 && taskIdx > rateIdx, "rate-limit section must come before ## Task in compact");
  assert.match(out, /handoff switch codex/);
  // Tool-specific compact primer with claude-code framing is slightly
  // heavier than the generic one (asserted < 2000 elsewhere), but should
  // still stay well inside the compact envelope.
  assert.ok(out.length < 2100, `compact primer with rate-limit block too long: ${out.length}`);
});

// -- subagent primer variant ----------------------------------------------

test("buildSubagentPrimer contains parent/subagent framing and write-lock warning", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildSubagentPrimer(paths, "claude-code");
  assert.match(out, /spawned from a parent session/);
  assert.match(out, /Do NOT modify/);
});

test("buildSubagentPrimer output is under 2000 chars on a realistic fixture", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildSubagentPrimer(paths, "claude-code");
  assert.ok(
    out.length < 2000,
    `subagent primer too long: ${out.length} chars >= 2000\n---\n${out}`,
  );
});

test("buildSubagentPrimer includes the task + latest correction + latest attempt", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildSubagentPrimer(paths, "claude-code");
  // Task section and the parent's goal.
  assert.match(out, /## Task/);
  assert.match(out, /portable session-state CLI/);
  // Latest (5th) correction present.
  assert.match(out, /## Latest corrections/);
  assert.match(out, /over-commented obvious code/);
  // Latest (5th) attempt present.
  assert.match(out, /## Latest failed attempts/);
  assert.match(out, /parsed attempts\.md with a naive split/);
});

test("buildSubagentPrimer drops environment / decisions / codebase-map / references / identity", async () => {
  const paths = scaffoldRealisticHandoff();
  const out = await buildSubagentPrimer(paths, "claude-code");
  assert.doesNotMatch(out, /## Environment/);
  assert.doesNotMatch(out, /## Decisions/);
  assert.doesNotMatch(out, /## Codebase map/);
  assert.doesNotMatch(out, /## References/);
  assert.doesNotMatch(out, /## Identity/);
  // And no rate-limit section either — handoffs are the parent's decision.
  assert.doesNotMatch(out, /## Rate-limit protocol/);
});
