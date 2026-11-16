import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveHandoffPaths } from "../src/format/paths.js";
import {
  extractConstraints,
  renderConstraintsBlock,
  verifyConstraintsPreserved,
} from "../src/format/constraints.js";
import { buildCompactPrimer, buildSubagentPrimer } from "../src/commands/prime.js";

function mkCorrection(ts: string, action: string, userSaid: string): string {
  return `\n## ${ts}\n\n**agent did:** ${action}\n\n**user said:** ${userSaid}\n\n---\n`;
}

/** The eight rules a real user might accumulate — all distinct, none recurring. */
const RULES = [
  "never generate markdown files unprompted",
  "keep runtimes fixed unless I ask",
  "always prefer pathlib over os.path",
  "never commit secrets or API keys",
  "keep the public API stable",
  "no containers for local scripts",
  "surgical diffs only, no drive-by refactors",
  "match the existing theme, don't invent colors",
];

function scaffold(): ReturnType<typeof resolveHandoffPaths> {
  const dir = mkdtempSync(join(tmpdir(), "handoff-constraints-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.task, "# Task\n\nBuild the thing without breaking the rules.\n");
  const body = RULES.map((rule, i) =>
    mkCorrection(`2026-01-0${i + 1}T00:00:00Z`, `did the wrong thing #${i + 1}`, rule),
  ).join("");
  writeFileSync(paths.corrections, `# Corrections\n${body}`);
  writeFileSync(paths.attempts, "# Attempts\n");
  return paths;
}

test("extractConstraints pulls the user's rule verbatim from each entry", () => {
  const cs = extractConstraints(scaffoldRaw());
  assert.equal(cs.length, RULES.length);
  for (const rule of RULES) {
    assert.ok(cs.some((c) => c.text === rule), `missing constraint: ${rule}`);
  }
});

test("extractConstraints prefers user-said, falls back to lesson, skips agent-did-only", () => {
  const raw = [
    "# Corrections",
    "\n## 2026-01-01T00:00:00Z\n\n**agent did:** used tabs\n\n**user said:** spaces only\n\n---\n",
    "\n## 2026-01-02T00:00:00Z\n\n**agent did:** wrong regex\n\n**lesson:** anchor the pattern\n\n---\n",
    // agent-did only: not a user constraint, must be skipped.
    "\n## 2026-01-03T00:00:00Z\n\n**agent did:** something\n\n---\n",
  ].join("");
  const cs = extractConstraints(raw);
  assert.deepEqual(cs.map((c) => c.text), ["spaces only", "anchor the pattern"]);
});

test("extractConstraints dedupes a restated rule and skips superseded entries", () => {
  const raw = [
    "# Corrections",
    "\n## 2026-01-01T00:00:00Z\n\n**user said:** always prefer pathlib\n\n---\n",
    "\n## 2026-01-02T00:00:00Z\n\n**user said:** always prefer pathlib\n\n---\n",
    "\n## 2026-01-03T00:00:00Z\n\n**superseded:** true\n\n**user said:** old rule\n\n---\n",
  ].join("");
  const cs = extractConstraints(raw);
  assert.deepEqual(cs.map((c) => c.text), ["always prefer pathlib"]);
});

test("renderConstraintsBlock returns empty string when there are no constraints", () => {
  assert.equal(renderConstraintsBlock([]), "");
});

test("verifyConstraintsPreserved flags a constraint missing from a primer", () => {
  const cs = extractConstraints(scaffoldRaw());
  const good = renderConstraintsBlock(cs);
  assert.equal(verifyConstraintsPreserved(good, cs).ok, true);

  const gutted = "# HANDOFF PRIMER\n\n(rules were summarized away)\n";
  const bad = verifyConstraintsPreserved(gutted, cs);
  assert.equal(bad.ok, false);
  assert.equal(bad.missing.length, RULES.length);
});

test("compact primer carries EVERY user constraint verbatim, past the recentN window", async () => {
  // The eight rules never recur, so ranking promotes none to a standing rule
  // and the recent tail would carry only the newest. Without constraint
  // preservation, seven of eight guardrails would be silently dropped.
  const out = await buildCompactPrimer(scaffold(), "generic");
  const { ok, missing } = verifyConstraintsPreserved(out, extractConstraints(scaffoldRaw()));
  assert.ok(ok, `compact primer dropped constraints: ${missing.map((m) => m.text).join("; ")}`);
  assert.match(out, /## User constraints \(carried verbatim/);
});

test("subagent primer also carries every user constraint verbatim", async () => {
  const out = await buildSubagentPrimer(scaffold(), "claude-code");
  const { ok, missing } = verifyConstraintsPreserved(out, extractConstraints(scaffoldRaw()));
  assert.ok(ok, `subagent primer dropped constraints: ${missing.map((m) => m.text).join("; ")}`);
});

test("prime --compact fails loudly (exit 1 + stderr) when a constraint can't be carried", () => {
  // A single rule too large to fit even the never-shed block forces the loss
  // the extractor exists to prevent; the post-compaction check must surface it.
  const dir = mkdtempSync(join(tmpdir(), "handoff-constraints-loud-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.task, `# Task\n\n${"t ".repeat(300)}\n`);
  const huge = `NEVER ${"delete production data ".repeat(200)}`;
  writeFileSync(paths.corrections, `# Corrections\n\n## 2026-01-01T00:00:00Z\n\n**user said:** ${huge}\n\n---\n`);
  writeFileSync(paths.attempts, "# Attempts\n");

  const CLI = resolve(process.cwd(), "bin", "handoff.mjs");
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [CLI, "prime", "--compact"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: string };
    status = err.status ?? 0;
    stderr = err.stderr ?? "";
  }
  assert.equal(status, 1, "must exit non-zero when a constraint is dropped");
  assert.match(stderr, /constraint\(s\) were dropped/);
});

test("a primer with no corrections has no constraints block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-constraints-none-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.task, "# Task\n\nfresh start\n");
  const out = await buildCompactPrimer(paths, "generic");
  assert.doesNotMatch(out, /## User constraints/);
});

/** The corrections.md body the scaffold writes, for direct extraction tests. */
function scaffoldRaw(): string {
  const body = RULES.map((rule, i) =>
    mkCorrection(`2026-01-0${i + 1}T00:00:00Z`, `did the wrong thing #${i + 1}`, rule),
  ).join("");
  return `# Corrections\n${body}`;
}

test("HOF-09 HOF-N2: compact CLI rejects loss and a larger budget carries all rules", async () => {
  const { spawnSync } = await import("node:child_process");
  const paths = scaffold();
  const rules = Array.from({ length: 25 }, (_, i) => `constraint ${i + 1}: ${"distinct guardrail ".repeat(10)}end`);
  writeFileSync(paths.corrections, "# Corrections\n" + rules.map((rule, i) =>
    mkCorrection(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, "action", rule)).join(""));
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const small = spawnSync(process.execPath, [cli, "prime", "--compact"], { cwd: paths.root, encoding: "utf8" });
  assert.equal(small.status, 1);
  assert.equal(small.stdout, "", "a rejected primer must not leak into a pipe");
  const large = spawnSync(process.execPath, [cli, "prime", "--compact", "--max-chars", "20000"], { cwd: paths.root, encoding: "utf8" });
  assert.equal(large.status, 0, large.stderr);
  assert.ok(rules.every((rule) => large.stdout.includes(rule)));
  assert.ok(large.stdout.length <= 20000);
});

test("HOF-11: CLI budgets bound every renderer or reject mandatory content", async () => {
  const { spawnSync } = await import("node:child_process");
  const paths = scaffold();
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  for (const flags of [[], ["--compact"], ["--subagent"]]) {
    for (const budget of [100, 500, 1000, 1999, 4000]) {
      const result = spawnSync(process.execPath, [cli, "prime", ...flags, "--max-chars", String(budget)], { cwd: paths.root, encoding: "utf8" });
      assert.ok(result.stdout.length <= budget, `${flags} emitted ${result.stdout.length} > ${budget}`);
      if (result.status === 0) assert.ok(RULES.every((r) => result.stdout.includes(r)));
      else {
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /budget|constraint|fit/);
      }
    }
  }
});
