import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../src/commands/decide.js";
import { correct } from "../src/commands/correct.js";
import { captureEvidence, STALE_ANNOTATION } from "../src/commands/evidence.js";
import { collectEvidenceStatus } from "../src/commands/stale.js";
import { buildPrimer, buildCompactPrimer, buildSubagentPrimer, buildStandingRulesContext } from "../src/commands/prime.js";
import { entryTextForRanking, isSuperseded, splitEntries } from "../src/commands/ranking.js";
import { resolveHandoffPaths } from "../src/format/paths.js";
import { TOOLS } from "../src/mcp/server.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(join(tmpdir(), "handoff-evidence-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  const paths = resolveHandoffPaths(root);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(join(root, "pyproject.toml"), "[project]\nname = 'demo'\n");
  return { base, root, paths };
}

function cli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
}

test("decide records relative SHA-256 evidence for multiple files and stale detects edits/deletion", async (t) => {
  const { root, paths } = await fixture(t);
  await fs.writeFile(join(root, "other @ file.txt"), "other");
  await decide({ cwd: root, choice: "use pymupdf", because: "fast", key: "demo",
    evidence: [join(root, "pyproject.toml"), "other @ file.txt"] });
  const raw = await fs.readFile(paths.decisions, "utf8");
  const hash = createHash("sha256").update(await fs.readFile(join(root, "pyproject.toml"))).digest("hex").slice(0, 16);
  assert.ok(raw.includes(`**evidence:** pyproject.toml@sha256:${hash}`));
  assert.ok(!raw.includes(root));
  let entries = await collectEvidenceStatus(paths);
  assert.deepEqual(entries[0]!.evidence.map((e) => e.status), ["OK", "OK"]);
  assert.equal(entries[0]!.firstLine, "**chose:** use pymupdf");
  assert.match(entries[0]!.timestamp!, /^\d{4}-\d\d-\d\dT/);
  await fs.appendFile(join(root, "pyproject.toml"), "version = '2'\n");
  entries = await collectEvidenceStatus(paths);
  assert.deepEqual(entries[0]!.evidence.map((e) => e.status), ["CHANGED", "OK"]);
  await fs.unlink(join(root, "pyproject.toml"));
  assert.equal((await collectEvidenceStatus(paths))[0]!.evidence[0]!.status, "MISSING");
});

for (const kind of ["decide", "correct"] as const) {
  test(`${kind}: re-logging a key excludes superseded stale evidence`, async (t) => {
    const { root, paths } = await fixture(t);
    const log = () => kind === "decide"
      ? decide({ cwd: root, choice: "use pymupdf", key: "demo", evidence: ["pyproject.toml"] })
      : correct({ cwd: root, action: "used another parser", userSaid: "use pymupdf", key: "demo",
        evidence: ["pyproject.toml"], quiet: true });
    await log();
    await fs.appendFile(join(root, "pyproject.toml"), "version = '2'\n");
    assert.equal((await collectEvidenceStatus(paths))[0]!.evidence[0]!.status, "CHANGED");
    await new Promise((r) => setTimeout(r, 5));
    await log();
    const entries = await collectEvidenceStatus(paths);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.evidence[0]!.status, "OK");
    const logPath = kind === "decide" ? paths.decisions : paths.corrections;
    const blocks = splitEntries(await fs.readFile(logPath, "utf8"));
    assert.equal(blocks.length, 2);
    assert.ok(isSuperseded(blocks[0]!));
    assert.doesNotMatch(await buildPrimer(paths, "generic", Infinity), /evidence changed/);
  });

  test(`${kind}: missing or outside evidence cannot append or revoke`, async (t) => {
    const { base, root, paths } = await fixture(t);
    const log = (evidence?: string[]) => kind === "decide"
      ? decide({ cwd: root, choice: "use pymupdf", key: "demo", evidence })
      : correct({ cwd: root, action: "used another parser", userSaid: "use pymupdf", key: "demo", evidence, quiet: true });
    await log();
    const logPath = kind === "decide" ? paths.decisions : paths.corrections;
    const before = await fs.readFile(logPath, "utf8");
    await fs.writeFile(join(base, "outside.txt"), "outside");
    for (const path of ["missing.txt", "../outside.txt", join(base, "outside.txt"), ".", "bad\npath"]) {
      await assert.rejects(log(["pyproject.toml", path]));
      assert.equal(await fs.readFile(logPath, "utf8"), before);
    }
  });
}

test("evidence rejects symlink escapes at logging and detects a later escape", async (t) => {
  const { base, root, paths } = await fixture(t);
  const outside = join(base, "outside.txt");
  const link = join(root, "link.txt");
  await fs.writeFile(outside, "outside");
  try {
    await fs.symlink(outside, link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable");
    throw error;
  }
  await assert.rejects(captureEvidence(root, ["link.txt"]), /inside the repository/);
  await fs.unlink(link);
  await fs.symlink("pyproject.toml", link);
  await decide({ cwd: root, choice: "use pymupdf", evidence: ["link.txt"] });
  assert.equal((await collectEvidenceStatus(paths))[0]!.evidence[0]!.status, "OK");
  await fs.unlink(link);
  await fs.symlink(outside, link);
  assert.equal((await collectEvidenceStatus(paths))[0]!.evidence[0]!.status, "CHANGED");
  assert.ok((await buildPrimer(paths, "generic", Infinity)).includes(STALE_ANNOTATION));
});

test("evidence that can no longer be read is flagged, and the primer is still produced", async (t) => {
  const { root, paths } = await fixture(t);
  const file = join(root, "notes.txt");
  await fs.writeFile(file, "basis");
  await decide({ cwd: root, choice: "use pymupdf", evidence: ["notes.txt"] });
  await fs.unlink(file);
  try {
    await fs.symlink("notes.txt", file); // a symlink to itself: realpath fails with ELOOP
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable");
    throw error;
  }
  assert.equal((await collectEvidenceStatus(paths))[0]!.evidence[0]!.status, "UNREADABLE");
  const primer = await buildPrimer(paths, "generic", Infinity);
  assert.ok(primer.includes(STALE_ANNOTATION));
  assert.ok(primer.includes("use pymupdf"));
});

test("evidence resolves from the supplied project root, not the process directory", async (t) => {
  const { root } = await fixture(t);
  const fromRelativeRoot = await captureEvidence(relative(process.cwd(), root), ["pyproject.toml"]);
  assert.deepEqual(fromRelativeRoot, await captureEvidence(root, ["pyproject.toml"]));
});

test("full, compact and subagent primers annotate changed/missing evidence without rewriting logs", async (t) => {
  const { root, paths } = await fixture(t);
  await decide({ cwd: root, choice: "use pymupdf", evidence: ["pyproject.toml"] });
  await correct({ cwd: root, action: "used another parser", userSaid: "use pymupdf", evidence: ["pyproject.toml"], quiet: true });
  const before = await fs.readFile(paths.corrections, "utf8");
  const render = () => Promise.all([buildPrimer(paths, "generic", Infinity), buildCompactPrimer(paths, "generic"), buildSubagentPrimer(paths, "generic")]);
  for (const primer of await render()) assert.ok(!primer.includes(STALE_ANNOTATION));
  await fs.appendFile(join(root, "pyproject.toml"), "version = '2'\n");
  for (const primer of await render()) assert.ok(primer.includes(STALE_ANNOTATION));
  await fs.unlink(join(root, "pyproject.toml"));
  for (const primer of await render()) assert.ok(primer.includes(STALE_ANNOTATION));
  assert.equal(await fs.readFile(paths.corrections, "utf8"), before);
});

test("OK evidence leaves primer rendering byte-identical to the existing full-log rendering", async (t) => {
  const { root, paths } = await fixture(t);
  await decide({ cwd: root, choice: "use pymupdf" });
  const plain = await buildPrimer(paths, "generic", Infinity);
  const raw = await fs.readFile(paths.decisions, "utf8");
  const evidence = (await captureEvidence(root, ["pyproject.toml"]))[0]!;
  await fs.writeFile(paths.decisions, raw.replace("\n---", `\n${evidence}\n---`));
  const withEvidence = await buildPrimer(paths, "generic", Infinity);
  assert.equal(withEvidence.replace(`\n${evidence}`, ""), plain);
});

test("standing rules and carried constraints retain stale warnings after entry truncation", async (t) => {
  const { root, paths } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    await correct({ cwd: root, action: "used another parser " + "context ".repeat(80),
      userSaid: "use pymupdf for PDF parsing", lesson: "use pymupdf for PDF parsing",
      evidence: ["pyproject.toml"], quiet: true });
    await new Promise((r) => setTimeout(r, 5));
  }
  await fs.unlink(join(root, "pyproject.toml"));
  assert.ok((await buildStandingRulesContext(paths)).includes(STALE_ANNOTATION));
  for (const primer of [await buildCompactPrimer(paths, "generic"), await buildSubagentPrimer(paths, "generic")]) {
    assert.ok(primer.includes("use pymupdf for PDF parsing" + STALE_ANNOTATION));
  }
});

test("evidence metadata does not affect relevance ranking text", () => {
  const entry = "## timestamp\n**user said:** use pymupdf\n**evidence:** pyproject.toml@sha256:0123456789abcdef";
  assert.equal(entryTextForRanking(entry), entryTextForRanking(entry.split("\n**evidence:")[0]!));
});

test("CLI stale --check/--json follows 0, 1, 0 and reports missing evidence", async (t) => {
  const { root } = await fixture(t);
  const log = () => cli(root, "decide", "use pymupdf", "--because", "fast", "--key", "demo", "--evidence", "pyproject.toml");
  assert.equal(log().status, 0);
  let result = cli(root, "stale", "--check");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^OK decisions.md /);
  await fs.appendFile(join(root, "pyproject.toml"), "version = '2'\n");
  result = cli(root, "stale", "--check", "--json");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout)[0].evidence[0].status, "CHANGED");
  assert.equal(cli(root, "stale").status, 0, "without --check staleness is advisory");
  assert.equal(log().status, 0);
  result = cli(root, "stale", "--check");
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /CHANGED/);
  await fs.unlink(join(root, "pyproject.toml"));
  result = cli(root, "stale", "--check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^MISSING /);
  assert.equal(cli(root, "decide", "missing", "--evidence", "pyproject.toml").status, 1);
  assert.equal(cli(root, "correct", "missing", "--user-said", "use pymupdf", "--evidence", "pyproject.toml").status, 1);
});

test("stale ignores entries without evidence and returns an empty JSON array", async (t) => {
  const { root } = await fixture(t);
  await decide({ cwd: root, choice: "use pymupdf" });
  const result = cli(root, "stale", "--check", "--json");
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test("MCP decision and correction schemas and handlers accept evidence and reject invalid input", async (t) => {
  const { root, paths } = await fixture(t);
  for (const name of ["handoff_log_decision", "handoff_log_correction"]) {
    const tool = TOOLS.find((tool) => tool.name === name)!;
    const properties = tool.inputSchema.properties as Record<string, any>;
    assert.equal(properties.evidence.type, "array");
    assert.deepEqual(properties.evidence.items, { type: "string" });
    assert.ok(!(tool.inputSchema.required as string[]).includes("evidence"));
    const args = name === "handoff_log_decision" ? { choice: "use pymupdf" }
      : { action: "used another parser", userSaid: "use pymupdf" };
    await tool.handler({ ...args, evidence: ["pyproject.toml"] }, { projectRoot: root, paths });
    const logPath = name === "handoff_log_decision" ? paths.decisions : paths.corrections;
    const before = await fs.readFile(logPath, "utf8");
    assert.match(before, /\*\*evidence:\*\* pyproject.toml@sha256:[a-f0-9]{16}/);
    for (const evidence of ["pyproject.toml", [42], ["missing.txt"], ["../outside.txt"]]) {
      await assert.rejects(tool.handler({ ...args, evidence }, { projectRoot: root, paths }));
      assert.equal(await fs.readFile(logPath, "utf8"), before);
    }
  }
  assert.equal((await collectEvidenceStatus(paths)).length, 2);
});
