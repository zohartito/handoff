import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, __lockConfig } from "../src/util/lock.js";
import { attempt } from "../src/commands/attempt.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "handoff-lock-test-"));
}

function scaffoldHandoffDir(): string {
  const dir = makeTmpDir();
  const handoffDir = join(dir, ".handoff");
  mkdirSync(handoffDir, { recursive: true });
  writeFileSync(join(handoffDir, "attempts.md"), "# Attempts\n\n");
  return dir;
}

// --- 1: single caller acquires, writes, releases -------------------------

test("withFileLock: single caller runs fn and removes lockfile after", async () => {
  const dir = makeTmpDir();
  const target = join(dir, "target.md");
  try {
    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
      // lockfile should exist during fn execution
      assert.equal(existsSync(`${target}.lock`), true, "lockfile exists during fn");
      await fs.writeFile(target, "hello", "utf8");
    });
    assert.equal(ran, true);
    assert.equal(existsSync(`${target}.lock`), false, "lockfile is gone after release");
    assert.equal(readFileSync(target, "utf8"), "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2: two concurrent callers serialize --------------------------------

test("withFileLock: two concurrent callers serialize, both succeed", async () => {
  const dir = makeTmpDir();
  const target = join(dir, "target.md");
  await fs.writeFile(target, "", "utf8");
  try {
    const order: string[] = [];
    const a = withFileLock(target, async () => {
      order.push("a-start");
      // Hold the lock long enough for B to contend.
      await new Promise((r) => setTimeout(r, 60));
      await fs.appendFile(target, "A\n", "utf8");
      order.push("a-end");
    });
    // Slight delay so A definitely grabs the lock first.
    await new Promise((r) => setTimeout(r, 5));
    const b = withFileLock(target, async () => {
      order.push("b-start");
      await fs.appendFile(target, "B\n", "utf8");
      order.push("b-end");
    });
    await Promise.all([a, b]);

    // A must fully finish before B starts — no interleaving.
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
    // Both writes landed.
    const contents = readFileSync(target, "utf8");
    assert.equal(contents, "A\nB\n");
    // Lockfile is cleaned up.
    assert.equal(existsSync(`${target}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3: stale lockfile is stolen -----------------------------------------

test("withFileLock: stale lockfile (older than staleMs) is stolen", async () => {
  const dir = makeTmpDir();
  const target = join(dir, "target.md");
  const lockPath = `${target}.lock`;
  // Temporarily shrink staleMs so the test runs fast. Also back-date the
  // processStartMs so the safety fence allows stealing.
  const origStale = __lockConfig.staleMs;
  const origRetry = __lockConfig.retryBudgetMs;
  const origProc = __lockConfig.processStartMs;
  __lockConfig.staleMs = 50;
  __lockConfig.retryBudgetMs = 2000;
  __lockConfig.processStartMs = Date.now() - 10_000;
  try {
    // Simulate a crashed process: lockfile exists, no owner to release it.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() - 5000 }), "utf8");
    // Back-date the lockfile's mtime so it's older than staleMs.
    const past = new Date(Date.now() - 5000);
    utimesSync(lockPath, past, past);

    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
      await fs.writeFile(target, "recovered", "utf8");
    });
    assert.equal(ran, true, "fn ran after stealing stale lock");
    assert.equal(existsSync(lockPath), false, "lockfile cleaned up");
    assert.equal(readFileSync(target, "utf8"), "recovered");
  } finally {
    __lockConfig.staleMs = origStale;
    __lockConfig.retryBudgetMs = origRetry;
    __lockConfig.processStartMs = origProc;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4: rejection on timeout ---------------------------------------------

test("withFileLock: throws informative error when lock is held past the retry budget", async () => {
  const dir = makeTmpDir();
  const target = join(dir, "target.md");
  const lockPath = `${target}.lock`;
  // Shrink the retry budget so the test isn't slow. Leave staleMs large so
  // we don't accidentally steal.
  const origRetry = __lockConfig.retryBudgetMs;
  const origStale = __lockConfig.staleMs;
  __lockConfig.retryBudgetMs = 150;
  __lockConfig.staleMs = 60_000;
  try {
    // Plant a "live" lockfile (fresh mtime) and do not release it.
    writeFileSync(lockPath, JSON.stringify({ pid: 42, ts: Date.now() }), "utf8");
    await assert.rejects(
      withFileLock(target, async () => {
        throw new Error("should never run");
      }),
      (err: Error) => {
        assert.match(err.message, /could not acquire lock/i);
        assert.match(err.message, /within 150ms/);
        return true;
      },
    );
    // The lockfile we planted should still be there — we did not steal it.
    assert.equal(existsSync(lockPath), true);
  } finally {
    __lockConfig.retryBudgetMs = origRetry;
    __lockConfig.staleMs = origStale;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5: error inside fn still releases the lock --------------------------

test("withFileLock: lock is released even if fn throws", async () => {
  const dir = makeTmpDir();
  const target = join(dir, "target.md");
  try {
    await assert.rejects(
      withFileLock(target, async () => {
        assert.equal(existsSync(`${target}.lock`), true);
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(existsSync(`${target}.lock`), false, "lockfile released after fn throw");

    // And the lock is immediately re-acquirable.
    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
    });
    assert.equal(ran, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 6: acceptance test — 5 concurrent `handoff attempt` calls ------------

test("acceptance: 5 concurrent handoff attempt calls produce 5 distinct entries, no corruption", async () => {
  const dir = scaffoldHandoffDir();
  const paths = resolveHandoffPaths(dir);
  try {
    // Swallow the command's console.log noise during the test.
    const origLog = console.log;
    console.log = () => {};
    try {
      await Promise.all([
        attempt({ what: "approach-1", fix: "fix-1", cwd: dir }),
        attempt({ what: "approach-2", fix: "fix-2", cwd: dir }),
        attempt({ what: "approach-3", fix: "fix-3", cwd: dir }),
        attempt({ what: "approach-4", fix: "fix-4", cwd: dir }),
        attempt({ what: "approach-5", fix: "fix-5", cwd: dir }),
      ]);
    } finally {
      console.log = origLog;
    }

    const contents = readFileSync(paths.attempts, "utf8");
    // Each call should produce exactly one "**tried:** approach-N" line.
    for (let i = 1; i <= 5; i++) {
      const marker = `**tried:** approach-${i}`;
      const count = contents.split(marker).length - 1;
      assert.equal(count, 1, `expected exactly one occurrence of "${marker}", got ${count}`);
    }
    // And exactly five entry separators — one per append.
    const separators = contents.split("\n---\n").length - 1;
    assert.equal(separators, 5, `expected 5 entry separators, got ${separators}`);
    // No leftover lockfile.
    assert.equal(existsSync(`${paths.attempts}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
