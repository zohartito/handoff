import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { obsidian } from "../src/commands/obsidian.js";

/**
 * Fixture builder: an isolated vault + project pair. The project has a
 * `.handoff/` with whatever entries the caller wrote via `seed`.
 */
function scaffoldFixture(
  projectBasename: string,
  seed: {
    task?: string;
    attempts?: string;
    decisions?: string;
    corrections?: string;
  } = {},
): { vault: string; project: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "handoff-obsidian-test-"));
  const vault = join(root, "vault");
  const project = join(root, projectBasename);
  mkdirSync(vault, { recursive: true });
  const handoffDir = join(project, ".handoff");
  mkdirSync(handoffDir, { recursive: true });
  if (seed.task !== undefined) writeFileSync(join(handoffDir, "task.md"), seed.task);
  if (seed.attempts !== undefined) writeFileSync(join(handoffDir, "attempts.md"), seed.attempts);
  if (seed.decisions !== undefined) writeFileSync(join(handoffDir, "decisions.md"), seed.decisions);
  if (seed.corrections !== undefined) writeFileSync(join(handoffDir, "corrections.md"), seed.corrections);
  return {
    vault,
    project,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const SAMPLE_DECISIONS = `# Decisions

## 2026-04-16T10:00:00Z

**chose:** Use NodeNext TypeScript for the new obsidian command

**because:** rest of the codebase uses it

---

## 2026-04-16T11:00:00Z

**chose:** Slug the project from its basename

**because:** stable across reruns

---
`;

const SAMPLE_CORRECTIONS = `# Corrections

## 2026-04-16T10:00:00Z

**agent did:** Overwrote the daily note clobbering prior content

**user said:** don't overwrite — append

**lesson:** never overwrite daily notes

---

## 2026-04-16T11:00:00Z

**agent did:** Emitted emojis in output

**user said:** no emojis

---
`;

// 1. ---------------------------------------------------------------------

test("obsidian sync: creates Daily / Decisions / Rules directories if missing", async () => {
  const fx = scaffoldFixture("proj-one", {
    task: "# Task\n\nBuild the obsidian command.\n",
    decisions: SAMPLE_DECISIONS,
    corrections: SAMPLE_CORRECTIONS,
  });
  const origLog = console.log;
  console.log = () => {};
  try {
    await obsidian({ vault: fx.vault, project: fx.project });
    assert.equal(existsSync(join(fx.vault, "Daily")), true, "Daily dir exists");
    assert.equal(existsSync(join(fx.vault, "Decisions")), true, "Decisions dir exists");
    assert.equal(existsSync(join(fx.vault, "Rules")), true, "Rules dir exists");
  } finally {
    console.log = origLog;
    fx.cleanup();
  }
});

// 2. ---------------------------------------------------------------------

test("obsidian sync: Daily note appends new block; second run same minute is a no-op", async () => {
  const fx = scaffoldFixture("proj-idem", {
    task: "# Task\n\nfoo\n",
  });
  const origLog = console.log;
  console.log = () => {};
  try {
    const first = await obsidian({ vault: fx.vault, project: fx.project });
    const dailyFiles = readdirSync(join(fx.vault, "Daily"));
    assert.equal(dailyFiles.length, 1, "one daily file");
    const dailyPath = join(fx.vault, "Daily", dailyFiles[0]);
    const afterFirst = readFileSync(dailyPath, "utf8");
    assert.match(afterFirst, /^## handoff: proj-idem — /m, "header present");
    assert.equal(first.daily, 1);

    // Second run within the same minute: should NOT append another block.
    const second = await obsidian({ vault: fx.vault, project: fx.project });
    const afterSecond = readFileSync(dailyPath, "utf8");
    assert.equal(afterSecond, afterFirst, "no-op: file bytes unchanged");
    assert.equal(second.daily, 0, "daily count is zero on no-op");
    assert.ok(second.skipped >= 1, "at least one skipped");

    // And only one handoff block in the file.
    const count = (afterSecond.match(/^## handoff: proj-idem/gm) ?? []).length;
    assert.equal(count, 1, "exactly one handoff block after two runs");
  } finally {
    console.log = origLog;
    fx.cleanup();
  }
});

// 3. ---------------------------------------------------------------------

test("obsidian sync: each decision entry produces one file in Decisions/", async () => {
  const fx = scaffoldFixture("proj-dec", {
    decisions: SAMPLE_DECISIONS,
  });
  const origLog = console.log;
  console.log = () => {};
  try {
    const counts = await obsidian({ vault: fx.vault, project: fx.project });
    const files = readdirSync(join(fx.vault, "Decisions"));
    assert.equal(files.length, 2, "two decision files — one per entry");
    assert.equal(counts.decisions, 2);
    // Each file is prefixed with the project slug.
    for (const f of files) {
      assert.match(f, /^\d{4}-\d{2}-\d{2}_proj-dec_/, `filename has date_slug prefix: ${f}`);
      assert.match(f, /\.md$/);
    }
  } finally {
    console.log = origLog;
    fx.cleanup();
  }
});

// 4. ---------------------------------------------------------------------

test("obsidian sync: each correction produces one file in Rules/", async () => {
  const fx = scaffoldFixture("proj-rules", {
    corrections: SAMPLE_CORRECTIONS,
  });
  const origLog = console.log;
  console.log = () => {};
  try {
    const counts = await obsidian({ vault: fx.vault, project: fx.project });
    const files = readdirSync(join(fx.vault, "Rules"));
    assert.equal(files.length, 2, "two rule files — one per correction");
    assert.equal(counts.corrections, 2);
    for (const f of files) {
      assert.match(f, /^proj-rules__/, `filename has slug prefix: ${f}`);
      assert.match(f, /\.md$/);
    }
  } finally {
    console.log = origLog;
    fx.cleanup();
  }
});

// 5. ---------------------------------------------------------------------

test("obsidian sync: opts.vault wins over env; missing both throws", async () => {
  const fx = scaffoldFixture("proj-vault", { task: "task" });
  const origEnv = process.env.HANDOFF_OBSIDIAN_VAULT;
  const origLog = console.log;
  console.log = () => {};
  try {
    // Case A: explicit --vault beats env when both are set.
    const otherVault = join(fx.vault, "..", "other-vault");
    mkdirSync(otherVault, { recursive: true });
    process.env.HANDOFF_OBSIDIAN_VAULT = otherVault;
    await obsidian({ vault: fx.vault, project: fx.project });
    assert.equal(
      existsSync(join(fx.vault, "Daily")),
      true,
      "explicit vault used",
    );
    assert.equal(
      existsSync(join(otherVault, "Daily")),
      false,
      "env vault NOT used",
    );

    // Case B: no explicit + no env → throw.
    delete process.env.HANDOFF_OBSIDIAN_VAULT;
    await assert.rejects(
      () => obsidian({ project: fx.project }),
      /no vault configured/i,
    );
  } finally {
    console.log = origLog;
    if (origEnv === undefined) delete process.env.HANDOFF_OBSIDIAN_VAULT;
    else process.env.HANDOFF_OBSIDIAN_VAULT = origEnv;
    fx.cleanup();
  }
});

// 6. ---------------------------------------------------------------------

test("obsidian sync: empty .handoff/ produces a Daily note with zero counts and no Decisions/Rules files", async () => {
  const fx = scaffoldFixture("proj-empty", {});
  const origLog = console.log;
  console.log = () => {};
  try {
    const counts = await obsidian({ vault: fx.vault, project: fx.project });
    const dailyFiles = readdirSync(join(fx.vault, "Daily"));
    assert.equal(dailyFiles.length, 1, "daily note created");
    const daily = readFileSync(join(fx.vault, "Daily", dailyFiles[0]), "utf8");
    assert.match(daily, /0 attempts \/ 0 decisions \/ 0 corrections/);
    assert.equal(counts.daily, 1);
    assert.equal(counts.decisions, 0);
    assert.equal(counts.corrections, 0);

    const decisionsFiles = readdirSync(join(fx.vault, "Decisions"));
    const rulesFiles = readdirSync(join(fx.vault, "Rules"));
    assert.equal(decisionsFiles.length, 0, "no decision files for empty input");
    assert.equal(rulesFiles.length, 0, "no rule files for empty input");
  } finally {
    console.log = origLog;
    fx.cleanup();
  }
});
