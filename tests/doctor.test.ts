import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, inspectShimForWrongPackage } from "../src/commands/doctor.js";
import { init } from "../src/commands/init.js";

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
    assert.match(out, /## summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  }
});

