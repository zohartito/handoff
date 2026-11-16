import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { init } from "../src/commands/init.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "handoff-init-test-"));
}

/**
 * Suppress console.log for a single async call. init() prints a fair amount
 * of next-step instructions that we don't care about in these tests.
 */
async function quiet(fn: () => Promise<void>, output?: string[]): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { output?.push(args.join(" ")); };
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

test("init: the printed handoff hint produces a primer for the requested tool", async () => {
  const dir = makeTmpDir();
  try {
    const output: string[] = [];
    await quiet(() => init({ cwd: dir }), output);
    const hint = output.join("\n").match(/when handing off: handoff (.+)/);
    assert.ok(hint, "init should print a next-step handoff command");
    const args = hint[1]!.replace("<target-tool>", "claude-code").trim().split(/\s+/);
    // Exercise the compiled CLI parser, not just the wording of the hint.
    const primer = execFileSync(process.execPath, [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)),
      ...args,
    ], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    assert.match(primer, /# HANDOFF PRIMER/);
    assert.match(primer, /You are Claude Code\./, "the hint must select the requested tool");
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

test("HOF-17: real save output appears in the compact environment summary", async () => {
  const { save } = await import("../src/commands/save.js");
  const { buildCompactPrimer } = await import("../src/commands/prime.js");
  const root = makeTmpDir();
  await quiet(() => init({ cwd: root }));
  await quiet(() => save({ cwd: root }));
  const output = await buildCompactPrimer(resolveHandoffPaths(root), "generic");
  assert.match(output, /## Environment/);
  assert.ok(output.includes(`node: ${process.version}`));
  assert.match(output, /os: /);
});

test("HOF-18: status distinguishes templates seeds and saved environment", async () => {
  const { save } = await import("../src/commands/save.js");
  const { status } = await import("../src/commands/status.js");
  const root = makeTmpDir();
  await quiet(() => init({ cwd: root }));
  const before: string[] = [];
  await quiet(() => status({ cwd: root }), before);
  assert.match(before.join("\n"), /environment\.md\s+template/);
  assert.match(before.join("\n"), /corrections\.md\s+seeded/);
  await quiet(() => save({ cwd: root }));
  const after: string[] = [];
  await quiet(() => status({ cwd: root }), after);
  assert.match(after.join("\n"), /environment\.md\s+filled/);
});

test("HOF-25 HOF-N5: generated guide and README list only logs a command writes", async () => {
  const dir = makeTmpDir();
  try {
    await quiet(() => init({ cwd: dir, from: "test" }));
    const guide = readFileSync(resolveHandoffPaths(dir).handoffMd, "utf8");
    for (const name of ["tool-history.jsonl", "transcript.jsonl", "file manifest with hashes"]) {
      assert.ok(!guide.includes(name), `HANDOFF.md must not promise ${name}`);
    }
    const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
    assert.ok(!/attempts\.md` and `transcript\.jsonl`/.test(readme), "README must not say attempt writes transcript.jsonl");
    assert.ok(!/append-only (per-tool event|narrative) log/.test(readme), "README layout must not list unwritten logs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
