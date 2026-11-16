import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeKey, entryKey, revokeActiveByKey } from "../src/commands/revocation.js";
import { rankEntries, splitEntries, isSuperseded } from "../src/commands/ranking.js";
import { retrieveFromRaw } from "../src/commands/retrieval.js";
import { correct } from "../src/commands/correct.js";

function mkKeyed(ts: string, key: string | null, chose: string): string {
  const k = key ? `**key:** ${key}\n\n` : "";
  return `\n## ${ts}\n\n${k}**chose:** ${chose}\n\n---\n`;
}

test("normalizeKey is case- and whitespace-insensitive", () => {
  assert.equal(normalizeKey("  Deploy   Target "), "deploy target");
  assert.equal(normalizeKey("deploy.target"), "deploy.target");
});

test("entryKey reads the key field, normalized; null when unkeyed", () => {
  assert.equal(entryKey(mkKeyed("2026-01-01T00:00:00Z", "Deploy.Target", "staging")), "deploy.target");
  assert.equal(entryKey(mkKeyed("2026-01-01T00:00:00Z", null, "staging")), null);
});

test("a newer fact revokes the older active entry under the same key", () => {
  const raw =
    `# Decisions\n` +
    mkKeyed("2026-01-01T00:00:00Z", "deploy.target", "staging") +
    mkKeyed("2026-01-02T00:00:00Z", "test.runner", "node:test");
  const { updated, revokedIds } = revokeActiveByKey(
    raw,
    "deploy.target",
    "2026-02-01T00:00:00Z",
    "2026-02-01T00:00:00Z",
  );

  assert.deepEqual(revokedIds, ["2026-01-01T00:00:00Z"]);
  const entries = splitEntries(updated);
  const [staging, runner] = entries;
  assert.match(staging!, /\*\*superseded:\*\* true/);
  assert.match(staging!, /\*\*revoked-by:\*\* 2026-02-01T00:00:00Z/);
  // Audit: the revoked entry's own content is untouched.
  assert.match(staging!, /\*\*chose:\*\* staging/);
  // Other keys are untouched.
  assert.doesNotMatch(runner!, /superseded/);
});

test("key matching ignores case and whitespace", () => {
  const raw = `# D\n` + mkKeyed("2026-01-01T00:00:00Z", "Deploy   Target", "staging");
  const { revokedIds } = revokeActiveByKey(raw, "deploy target", "x", "x");
  assert.deepEqual(revokedIds, ["2026-01-01T00:00:00Z"]);
});

test("already-revoked entries keep their original provenance", () => {
  const raw = `# D\n` + mkKeyed("2026-01-01T00:00:00Z", "deploy.target", "staging");
  const first = revokeActiveByKey(raw, "deploy.target", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
  const second = revokeActiveByKey(first.updated, "deploy.target", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");

  assert.deepEqual(second.revokedIds, []);
  const markers = second.updated.match(/\*\*superseded:\*\* true/g) ?? [];
  assert.equal(markers.length, 1, "no double-stamping");
  assert.match(second.updated, /\*\*revoked-by:\*\* 2026-02-01T00:00:00Z/);
});

test("the revoking entry itself is never revoked", () => {
  const raw = `# D\n` + mkKeyed("2026-02-01T00:00:00Z", "deploy.target", "prod");
  const { revokedIds } = revokeActiveByKey(raw, "deploy.target", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
  assert.deepEqual(revokedIds, []);
});

test("re-promotion: re-asserting an old value revokes the newer fact in turn", () => {
  // staging → prod (revokes staging) → staging again (revokes prod).
  let raw = `# D\n` + mkKeyed("2026-01-01T00:00:00Z", "deploy.target", "staging");
  raw = revokeActiveByKey(raw, "deploy.target", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z").updated;
  raw += mkKeyed("2026-02-01T00:00:00Z", "deploy.target", "prod");
  const third = revokeActiveByKey(raw, "deploy.target", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
  raw = third.updated + mkKeyed("2026-03-01T00:00:00Z", "deploy.target", "staging");

  assert.deepEqual(third.revokedIds, ["2026-02-01T00:00:00Z"]);
  const active = splitEntries(raw).filter((e) => !isSuperseded(e));
  assert.equal(active.length, 1, "exactly one active entry per key");
  assert.match(active[0]!, /\*\*chose:\*\* staging/);
  // Full history is still in the file for audit.
  assert.equal(splitEntries(raw).length, 3);
});

test("revoked entries are excluded from task retrieval", () => {
  let raw =
    `# D\n` +
    mkKeyed("2026-01-01T00:00:00Z", "deploy.target", "deploy target is the staging cluster") +
    mkKeyed("2026-01-02T00:00:00Z", null, "unrelated: lint with tsc --noEmit");
  raw = revokeActiveByKey(raw, "deploy.target", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z").updated;
  raw += mkKeyed("2026-02-01T00:00:00Z", "deploy.target", "deploy target is the prod cluster");

  const hits = retrieveFromRaw(raw, "update the deploy target cluster config");
  assert.ok(hits.length > 0, "the active fact should be retrieved");
  assert.ok(
    hits.every((h) => h.id !== "2026-01-01T00:00:00Z"),
    "the stale fact must not resurface via task relevance",
  );
  // Sanity: ranking is superseded-aware too (existing behavior, still holds).
  const { recent } = rankEntries(raw, { recentN: 10, maxStanding: 5 });
  assert.ok(recent.every((e) => !/staging cluster/.test(e)));
});

test("correct --key end to end: revoke-then-append under one lock", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "handoff-revocation-"));
  try {
    await fs.mkdir(join(dir, ".handoff"), { recursive: true });
    await correct({
      action: "assumed the primary checkout is on the Mac",
      userSaid: "primary development is on the PC now",
      key: "Primary.Checkout",
      cwd: dir,
      quiet: true,
    });
    // Ids are ms-resolution timestamps; keep the two entries distinct.
    await new Promise((r) => setTimeout(r, 5));
    await correct({
      action: "assumed the primary checkout is on the PC",
      userSaid: "primary development moved back to the Mac",
      key: "primary.checkout",
      cwd: dir,
      quiet: true,
    });

    const raw = await fs.readFile(join(dir, ".handoff", "corrections.md"), "utf8");
    const entries = splitEntries(raw);
    assert.equal(entries.length, 2);
    const active = entries.filter((e) => !isSuperseded(e));
    assert.equal(active.length, 1);
    assert.match(active[0]!, /moved back to the Mac/);
    const revoked = entries.find((e) => isSuperseded(e))!;
    assert.match(revoked, /\*\*revoked-by:\*\* /);
    assert.match(revoked, /primary development is on the PC now/, "audit trail keeps full text");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HOF-06: CLI hook and switch full primers omit revoked facts", async () => {
  const { spawnSync } = await import("node:child_process");
  const { decide } = await import("../src/commands/decide.js");
  const { selectPrimer } = await import("../src/commands/switch.js");
  const { resolveHandoffPaths } = await import("../src/format/paths.js");
  const root = await fs.mkdtemp(join(tmpdir(), "handoff-prime-revoked-"));
  await fs.mkdir(join(root, ".handoff"));
  await decide({ cwd: root, choice: "OLD_DEPLOY_VALUE", key: "deploy.target" });
  await correct({ cwd: root, action: "indent", userSaid: "OLD_INDENT_VALUE", key: "style.indent", quiet: true });
  await new Promise((r) => setTimeout(r, 5));
  await decide({ cwd: root, choice: "NEW_DEPLOY_VALUE", key: "deploy.target" });
  await correct({ cwd: root, action: "indent", userSaid: "NEW_INDENT_VALUE", key: "style.indent", quiet: true });
  const cli = new URL("../src/cli.js", import.meta.url);
  for (const args of [["prime"], ["prime", "--tool", "cursor"], ["hook", "session-start"]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(cli), ...args], { cwd: root, encoding: "utf8", input: "{}" });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /OLD_DEPLOY_VALUE|OLD_INDENT_VALUE/);
    assert.match(result.stdout, /NEW_DEPLOY_VALUE/);
    assert.match(result.stdout, /NEW_INDENT_VALUE/);
  }
  const selected = await selectPrimer(resolveHandoffPaths(root), "cursor", false);
  assert.doesNotMatch(selected.primer, /OLD_DEPLOY_VALUE|OLD_INDENT_VALUE/);
  assert.match(await fs.readFile(join(root, ".handoff/decisions.md"), "utf8"), /OLD_DEPLOY_VALUE/);
});

for (const fence of ["```", "~~~~"]) {
  test(`HOF-06: fenced H2 revoked facts stay out of CLI hook and switch primers (${fence})`, async () => {
    const { spawnSync } = await import("node:child_process");
    const { decide } = await import("../src/commands/decide.js");
    const { selectPrimer } = await import("../src/commands/switch.js");
    const { resolveHandoffPaths } = await import("../src/format/paths.js");
    const root = await fs.mkdtemp(join(tmpdir(), "handoff-fenced-revocation-"));
    await fs.mkdir(join(root, ".handoff"));
    const paths = resolveHandoffPaths(root);
    const oldDecision = `previous deployment example\n\n${fence}markdown\n## REVOKED_FENCED_DECISION\nold deploy body\n${fence}`;
    const oldCorrection = `previous style example\n\n${fence}markdown\n## REVOKED_FENCED_CORRECTION\nold style body\n${fence}`;
    const currentDecision = `current deployment example\n\n${fence}markdown\n## CURRENT_FENCED_DECISION\ncurrent deploy body\n${fence}`;
    const currentCorrection = `current style example\n\n${fence}markdown\n## CURRENT_FENCED_CORRECTION\ncurrent style body\n${fence}`;
    await decide({ cwd: root, choice: oldDecision, key: "deploy.target" });
    await correct({ cwd: root, action: "indent", userSaid: oldCorrection, key: "style.indent", quiet: true });
    await new Promise((r) => setTimeout(r, 5));
    await decide({ cwd: root, choice: currentDecision, key: "deploy.target" });
    await correct({ cwd: root, action: "indent", userSaid: currentCorrection, key: "style.indent", quiet: true });
    await decide({ cwd: root, choice: "UNRELATED_ACTIVE_DECISION" });
    const storedDecisions = await fs.readFile(paths.decisions, "utf8");
    const storedCorrections = await fs.readFile(paths.corrections, "utf8");
    assert.ok(storedDecisions.includes(oldDecision), "revocation preserves the full decision for audit");
    assert.ok(storedCorrections.includes(oldCorrection), "revocation preserves the full correction for audit");
    assert.match(storedDecisions, /\*\*superseded:\*\* true/);
    assert.match(storedCorrections, /\*\*superseded:\*\* true/);

    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const outputs: Array<[string, string]> = [];
    for (const args of [["prime"], ["prime", "--tool", "cursor"], ["hook", "session-start"]]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", input: "{}" });
      assert.equal(result.status, 0, result.stderr);
      const primer = args[0] === "hook"
        ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string
        : result.stdout;
      outputs.push([args.join(" "), primer]);
    }
    outputs.push(["switch selection", (await selectPrimer(paths, "cursor", false)).primer]);
    for (const [surface, primer] of outputs) {
      assert.doesNotMatch(primer, /REVOKED_FENCED_DECISION|REVOKED_FENCED_CORRECTION|old deploy body|old style body/, surface);
      assert.ok(primer.includes(currentDecision), `${surface} keeps the complete active decision`);
      assert.ok(primer.includes(currentCorrection), `${surface} keeps the complete active correction`);
      assert.match(primer, /UNRELATED_ACTIVE_DECISION/, surface);
    }
    assert.equal(await fs.readFile(paths.decisions, "utf8"), storedDecisions, "primers never rewrite decision history");
    assert.equal(await fs.readFile(paths.corrections, "utf8"), storedCorrections, "primers never rewrite correction history");
  });
}
