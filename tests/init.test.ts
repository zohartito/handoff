import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands/init.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "handoff-init-test-"));
}

/**
 * Suppress console.log for a single async call. init() prints a fair amount
 * of next-step instructions that we don't care about in these tests.
 */
async function quiet(fn: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("init: does NOT create empty transcript.jsonl or tool-history.jsonl", async () => {
  // Regression for v0.7: pre-creating these files as 1-byte newlines was
  // misleading — follow-up agents opened them expecting content. v0.7 stops
  // creating them on init. They should be absent until `handoff capture` or
  // `handoff ingest` actually write to them.
  const dir = makeTmpDir();
  try {
    await quiet(() => init({ cwd: dir, from: "test" }));
    const paths = resolveHandoffPaths(dir);
    assert.equal(
      existsSync(paths.transcript),
      false,
      "transcript.jsonl must not be created by `init`",
    );
    assert.equal(
      existsSync(paths.toolHistory),
      false,
      "tool-history.jsonl must not be created by `init`",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: creates the expected non-empty template / meta files", async () => {
  // Guardrail: the change above must not accidentally stop creating the real
  // files. If someone removes the wrong `appendLine` / `writeJson`, this test
  // will catch it.
  const dir = makeTmpDir();
  try {
    await quiet(() => init({ cwd: dir, from: "test" }));
    const paths = resolveHandoffPaths(dir);
    assert.equal(existsSync(paths.dir), true, ".handoff/ should exist");
    assert.equal(existsSync(paths.meta), true, "meta.json should exist");
    assert.equal(existsSync(paths.filesManifest), true, "files.json should exist");
    assert.equal(existsSync(paths.task), true, "task.md should exist");
    assert.equal(existsSync(paths.identity), true, "identity.md should exist");
    assert.equal(existsSync(paths.handoffMd), true, "HANDOFF.md should exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
