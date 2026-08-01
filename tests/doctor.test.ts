import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctor,
  inspectShimForWrongPackage,
  extractVersions,
  cmpSemver,
} from "../src/commands/doctor.js";
import { init } from "../src/commands/init.js";

/** Init a git repo in `cwd` with a deterministic identity for fixtures. */
function gitInit(cwd: string): void {
  const opts = { cwd, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opts);
  execFileSync("git", ["config", "user.email", "t@t.test"], opts);
  execFileSync("git", ["config", "user.name", "Test"], opts);
  execFileSync("git", ["config", "commit.gpgsign", "false"], opts);
}

/** Make `n` empty commits so commit-count thresholds can be exercised. */
function emptyCommits(cwd: string, n: number, msg = "c"): void {
  for (let i = 0; i < n; i++) {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", `${msg} ${i}`], {
      cwd,
      stdio: "ignore",
    });
  }
}

/** Overwrite meta.json's updatedAt to an old ISO timestamp. */
function setUpdatedAt(cwd: string, iso: string): void {
  const metaPath = join(cwd, ".handoff", "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.updatedAt = iso;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "handoff-doctor-test-"));
}

/**
 * Capture stdout output from doctor(). Mirrors the captureStdout helper in
 * install.test.ts — console.log is the doctor's only output channel.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    );
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

async function quietInit(cwd: string): Promise<void> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await init({ cwd, from: "test" });
  } finally {
    console.log = log;
    console.error = err;
  }
}

// --- inspectShimForWrongPackage: pure detection ---------------------------

test("inspectShimForWrongPackage: detects stale @handoff/cli reference in a .cmd shim", async () => {
  // This is the actual failure case from the v0.7 upgrade: a leftover
  // npm-generated Windows .cmd shim that still points at the pre-rename
  // package. The shim body references the target .mjs path, which embeds
  // the package name as plain text.
  const dir = makeTmpDir();
  try {
    const shim = join(dir, "handoff.cmd");
    writeFileSync(
      shim,
      // Realistic-ish npm .cmd shim body.
      "@ECHO OFF\r\nnode \"%~dp0\\node_modules\\@handoff\\cli\\bin\\handoff.mjs\" %*\r\n",
      "utf8",
    );
    const found = await inspectShimForWrongPackage(shim);
    assert.equal(found, "@handoff/cli", "should report the wrong package name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectShimForWrongPackage: returns null for a healthy @zohartito/handoff shim", async () => {
  const dir = makeTmpDir();
  try {
    const shim = join(dir, "handoff.cmd");
    writeFileSync(
      shim,
      "@ECHO OFF\r\nnode \"%~dp0\\node_modules\\@zohartito\\handoff\\bin\\handoff.mjs\" %*\r\n",
      "utf8",
    );
    const found = await inspectShimForWrongPackage(shim);
    assert.equal(found, null, "a shim pointing at the correct package is fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectShimForWrongPackage: ignores shims with no scoped package ref at all", async () => {
  // If the shim doesn't reference a scoped package (e.g. a hand-rolled
  // wrapper or a non-npm install), we have no signal — return null, don't
  // raise a false alarm.
  const dir = makeTmpDir();
  try {
    const shim = join(dir, "handoff.cmd");
    writeFileSync(shim, "@ECHO OFF\r\nnode /usr/local/bin/handoff.mjs %*\r\n", "utf8");
    const found = await inspectShimForWrongPackage(shim);
    assert.equal(found, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectShimForWrongPackage: missing file returns null (no crash)", async () => {
  const dir = makeTmpDir();
  try {
    const found = await inspectShimForWrongPackage(join(dir, "does-not-exist"));
    assert.equal(found, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- doctor end-to-end ----------------------------------------------------

test("doctor: clean project (no .handoff/) reports the missing-dir error", async () => {
  const dir = makeTmpDir();
  try {
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.match(out, /\.handoff\/ missing/);
    assert.match(out, /run `handoff init`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // doctor sets process.exitCode on errors; reset so the test runner's
    // own exit doesn't inherit.
    process.exitCode = 0;
  }
});

test("doctor: freshly-initialised project does NOT flag missing jsonl files", async () => {
  // v0.7 init no longer creates transcript.jsonl / tool-history.jsonl. Doctor
  // must treat "file absent" as the happy path, not a warning.
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.doesNotMatch(
      out,
      /transcript\.jsonl is empty/,
      "absent transcript.jsonl must not produce the stale-jsonl warning",
    );
    assert.doesNotMatch(
      out,
      /tool-history\.jsonl is empty/,
      "absent tool-history.jsonl must not produce the stale-jsonl warning",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor: flags empty 0-byte jsonl files as stale leftovers", async () => {
  // Simulate a project initialised with an older (<=0.6) handoff CLI that
  // still pre-created the empty jsonl files. Doctor should warn so the user
  // knows to delete them or run `handoff capture`.
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    const handoff = join(dir, ".handoff");
    writeFileSync(join(handoff, "transcript.jsonl"), "", "utf8");
    writeFileSync(join(handoff, "tool-history.jsonl"), "", "utf8");
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.match(out, /transcript\.jsonl is empty/);
    assert.match(out, /tool-history\.jsonl is empty/);
    assert.match(out, /handoff capture/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor: non-empty jsonl files are not flagged as stale", async () => {
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    const handoff = join(dir, ".handoff");
    writeFileSync(
      join(handoff, "tool-history.jsonl"),
      JSON.stringify({ tool: "Read", ts: "2025-01-01T00:00:00Z" }) + "\n",
      "utf8",
    );
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.doesNotMatch(
      out,
      /tool-history\.jsonl is empty/,
      "a jsonl file with real content must not be flagged",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor: produces the expected section headers", async () => {
  // Lightweight structural check — catches accidental regressions where a
  // section gets reordered or removed. Uses an empty tmp dir so the output
  // is minimal.
  const dir = makeTmpDir();
  try {
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.match(out, /## project/);
    assert.match(out, /## global install/);
    assert.match(out, /## claude code hooks/);
    assert.match(out, /## git/);
    assert.match(out, /## staleness/);
    assert.match(out, /## summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

// --- extractVersions / cmpSemver: pure units ------------------------------

test("extractVersions: matches three-part versions, excludes dates/counts/times/two-part", () => {
  const text = [
    "shipped as 0.7.1 and earlier 0.4.0",
    "date 2026-07-31, tests 160/160, time 23:38:32",
    "needs node >=22.5 and v1 through v7",
    "@0.6.0 was the prior tag",
  ].join("\n");
  const found = extractVersions(text);
  assert.deepEqual(found, ["0.7.1", "0.4.0", "0.6.0"]);
  // Explicit negatives — none of these noise tokens should appear.
  assert.ok(!found.includes("2026-07-31"));
  assert.ok(!found.includes("160"));
  assert.ok(!found.includes("23.38.32"));
  assert.ok(!found.includes("22.5"));
});

test("extractVersions: empty text yields empty array (no crash)", () => {
  assert.deepEqual(extractVersions(""), []);
});

test("cmpSemver: orders versions numerically incl. 0.10.0 > 0.9.9", () => {
  assert.ok(cmpSemver("0.4.0", "0.7.1") < 0);
  assert.ok(cmpSemver("0.7.1", "0.4.0") > 0);
  assert.equal(cmpSemver("1.2.3", "1.2.3"), 0);
  // The classic lexical-vs-numeric trap: 10 > 9 numerically.
  assert.ok(cmpSemver("0.10.0", "0.9.9") > 0);
  assert.ok(cmpSemver("1.0.0", "0.99.99") > 0);
});

// --- staleness end-to-end -------------------------------------------------

test("doctor staleness: stale artifact fires but exit code stays 0", async () => {
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    gitInit(dir);
    // Backdate the save, then land >= 10 commits after it.
    setUpdatedAt(dir, "2020-01-01T00:00:00.000Z");
    emptyCommits(dir, 12);
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.match(out, /artifact not saved in the last \d+ commits/);
    assert.equal(process.exitCode, 0, "staleness is warn-only — must not fail the exit code");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor staleness: fresh artifact (few commits since save) stays silent", async () => {
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    gitInit(dir);
    // meta.updatedAt is ~now (just initialised); a couple of commits after.
    emptyCommits(dir, 2);
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.doesNotMatch(out, /artifact not saved in the last/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor staleness: version drift fires when task.md is behind package.json", async () => {
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    gitInit(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.7.1" }), "utf8");
    writeFileSync(
      join(dir, ".handoff", "task.md"),
      "# Task\n\nValidating live @0.4.0 on macOS. Tests 160/160 on 2026-07-31.\n",
      "utf8",
    );
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.match(out, /task\.md's newest version reference \(0\.4\.0\) is behind package\.json \(0\.7\.1\)/);
    assert.equal(process.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor staleness: version drift silent when task.md is current", async () => {
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    gitInit(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.7.1" }), "utf8");
    writeFileSync(
      join(dir, ".handoff", "task.md"),
      "# Task\n\nShipped as 0.7.1. History: started at 0.4.0.\n",
      "utf8",
    );
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.doesNotMatch(out, /is behind package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor staleness: no package.json does not crash and skips version check", async () => {
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    gitInit(dir);
    writeFileSync(join(dir, ".handoff", "task.md"), "# Task\n\nWorking on 0.1.0.\n", "utf8");
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.match(out, /## staleness/);
    assert.doesNotMatch(out, /is behind package\.json/);
    assert.doesNotMatch(out, /is current with package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor staleness: no-git repo → section present, no A/D warnings, no throw", async () => {
  const dir = makeTmpDir();
  try {
    await quietInit(dir); // no gitInit — not a repo
    const out = await captureStdout(() => doctor({ cwd: dir }));
    assert.match(out, /## staleness/);
    assert.doesNotMatch(out, /artifact not saved in the last/);
    assert.doesNotMatch(out, /unchanged across the last/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor staleness: dormant-but-healthy → ZERO warn lines in the staleness section", async () => {
  // The anti-cry-wolf guard. Old save timestamp, but NO new commits and
  // nothing else wrong → the commit-count design must self-degrade to silence.
  const dir = makeTmpDir();
  try {
    await quietInit(dir);
    gitInit(dir);
    setUpdatedAt(dir, "2020-01-01T00:00:00.000Z"); // ancient timestamp
    emptyCommits(dir, 1); // one commit, but it predates nothing meaningful
    const out = await captureStdout(() => doctor({ cwd: dir }));
    const section = out.slice(out.indexOf("## staleness"), out.indexOf("## summary"));
    assert.ok(
      !section.includes("○ warn"),
      `dormant-but-healthy must produce no warn lines, got:\n${section}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

test("doctor staleness: log-silence fires with content, silent on template", async () => {
  // With real logged content and >= 25 commits since it last changed → warn.
  const withContent = makeTmpDir();
  try {
    await quietInit(withContent);
    gitInit(withContent);
    writeFileSync(
      join(withContent, ".handoff", "attempts.md"),
      "# Attempts\n\n## Tried the fast path\nDidn't work because X.\n",
      "utf8",
    );
    execFileSync("git", ["add", "-A"], { cwd: withContent, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "log an attempt"], {
      cwd: withContent,
      stdio: "ignore",
    });
    emptyCommits(withContent, 30);
    const out = await captureStdout(() => doctor({ cwd: withContent }));
    assert.match(out, /attempts\.md unchanged across the last \d+ commits/);
    assert.equal(process.exitCode, 0);
  } finally {
    rmSync(withContent, { recursive: true, force: true });
    process.exitCode = 0;
  }

  // Template-only attempts.md → gated out, no warn even after many commits.
  const template = makeTmpDir();
  try {
    await quietInit(template);
    gitInit(template);
    execFileSync("git", ["add", "-A"], { cwd: template, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: template, stdio: "ignore" });
    emptyCommits(template, 30);
    const out = await captureStdout(() => doctor({ cwd: template }));
    assert.doesNotMatch(out, /attempts\.md unchanged across the last/);
  } finally {
    rmSync(template, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

