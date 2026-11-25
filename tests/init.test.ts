import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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

test("HOF-18: status distinguishes seeds from the environment init captures", async () => {
  const { status } = await import("../src/commands/status.js");
  const root = makeTmpDir();
  await quiet(() => init({ cwd: root }));
  const after: string[] = [];
  await quiet(() => status({ cwd: root }), after);
  assert.match(after.join("\n"), /corrections\.md\s+seeded/);
  // init runs save(), so environment.md already holds captured facts.
  assert.match(after.join("\n"), /environment\.md\s+filled/);
});

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

/** Run the compiled CLI with git config/identity isolated from the host. */
function runCli(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(cwd, "..", "empty-gitconfig"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
    ...extraEnv,
  });
  return spawnSync(args[0] === "git" ? "git" : process.execPath,
    args[0] === "git" ? args.slice(1) : [cliPath, ...args],
    { cwd, env, encoding: "utf8", timeout: 20_000 });
}

test("init: compiled init→prime (no explicit save) carries real git facts", () => {
  const scratch = realpathSync(makeTmpDir());
  const repo = join(scratch, "init-facts-repo");
  try {
    mkdirSync(repo);
    writeFileSync(join(scratch, "empty-gitconfig"), "");
    const subject = "docs: seed init facts README";
    assert.equal(runCli(repo, ["git", "init", "--initial-branch=main", "--template="]).status, 0);
    writeFileSync(join(repo, "README.md"), "# init-facts-repo\n");
    assert.equal(runCli(repo, ["git", "add", "README.md"]).status, 0);
    assert.equal(runCli(repo, ["git", "-c", "commit.gpgSign=false", "commit", "-m", subject]).status, 0);

    assert.equal(runCli(repo, ["init"]).status, 0);
    const primed = runCli(repo, ["prime", "--tool", "claude-code"]);
    assert.equal(primed.status, 0, primed.stderr);
    const out = primed.stdout;
    assert.ok(out.includes(`- cwd: \`${repo}\``), "primer must carry the actual cwd");
    assert.ok(out.includes("- git branch: `main`"), "primer must carry the actual branch");
    assert.ok(out.includes(subject), "primer must carry the known commit subject");
    assert.match(out, /^\?\? \.handoff\/$/m, "primer must carry observed .handoff/ status");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("init: outside git succeeds; refused re-init leaves every file byte-identical", () => {
  const scratch = realpathSync(makeTmpDir());
  const dir = join(scratch, "plain");
  try {
    mkdirSync(dir);
    writeFileSync(join(scratch, "empty-gitconfig"), "");
    // Stop git discovering an enclosing repository above the temp dir.
    const noRepo = { GIT_CEILING_DIRECTORIES: scratch };
    const first = runCli(dir, ["init"], noRepo);
    assert.equal(first.status, 0, first.stderr);
    const paths = resolveHandoffPaths(dir);
    const envDoc = readFileSync(paths.environment, "utf8");
    assert.ok(envDoc.includes("- git: (not a repo)"));
    assert.ok(envDoc.includes(`node: ${process.version}`));

    const snapshot = () => Object.fromEntries(readdirSync(paths.dir).sort()
      .map((name) => [name, readFileSync(join(paths.dir, name)).toString("base64")]));
    const before = snapshot();
    const again = runCli(dir, ["init"], noRepo);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
    assert.deepEqual(snapshot(), before, "refused init must not touch .handoff/");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
