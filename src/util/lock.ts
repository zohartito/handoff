import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * Cross-process advisory file lock for markdown read-modify-write paths.
 *
 * Uses `fs.open(path, 'wx')` — atomic exclusive create, supported on POSIX and
 * NTFS. On contention, retries with exponential backoff. Stale locks (process
 * crashed without cleanup) are stolen after STALE_MS, subject to a safety
 * fence so we don't rip a freshly-written lock from a concurrent peer that
 * started on the same tick.
 *
 * Only wrap RMW on markdown files. JSONL paths use fs.appendFile which is its
 * own sync boundary for single-line small writes.
 */

const INITIAL_BACKOFF_MS = 20;
const MAX_BACKOFF_MS = 500;
const RETRY_BUDGET_MS = 5000;
const STALE_MS = 10_000;
const PROCESS_START_MS = Date.now();

/** Exposed for tests so they can override timing. */
export const __lockConfig = {
  initialBackoffMs: INITIAL_BACKOFF_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
  retryBudgetMs: RETRY_BUDGET_MS,
  staleMs: STALE_MS,
  processStartMs: PROCESS_START_MS,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryCreateLock(lockPath: string): Promise<boolean> {
  await fs.mkdir(dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    // Write our pid + timestamp so a debugger can see who owns it.
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
      "utf8",
    );
    await handle.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function maybeStealStaleLock(lockPath: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    // Lock disappeared between the failed create and now — caller will retry
    // the create.
    return false;
  }
  const now = Date.now();
  const lockAgeMs = now - stat.mtimeMs;
  const ourAgeMs = now - __lockConfig.processStartMs;
  // Safety fence: only steal when the lockfile *and* our process are both
  // older than STALE_MS. This avoids stealing a lock that was freshly written
  // by a peer on the same tick when both processes just started.
  if (lockAgeMs > __lockConfig.staleMs && ourAgeMs > __lockConfig.staleMs) {
    try {
      await fs.unlink(lockPath);
      return true;
    } catch {
      // Someone else may have cleaned it up already.
      return false;
    }
  }
  return false;
}

/**
 * Acquire an advisory lock on `<filePath>.lock`, run `fn`, release the lock.
 *
 * The lock is released whether `fn` resolves or rejects. If the lock cannot
 * be acquired within the retry budget, throws an Error.
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  let backoff = __lockConfig.initialBackoffMs;

  while (true) {
    if (await tryCreateLock(lockPath)) {
      try {
        return await fn();
      } finally {
        try {
          await fs.unlink(lockPath);
        } catch {
          // Best-effort. If the file is already gone (e.g. stolen), ignore.
        }
      }
    }

    // Contention: try stealing stale, otherwise back off.
    if (await maybeStealStaleLock(lockPath)) {
      // Immediate retry on next loop iteration — we just cleared it.
      continue;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= __lockConfig.retryBudgetMs) {
      throw new Error(
        `withFileLock: could not acquire lock on ${filePath} within ` +
          `${__lockConfig.retryBudgetMs}ms (held by another process at ${lockPath}). ` +
          `If the holder crashed, the lock will be reclaimed after ${__lockConfig.staleMs}ms.`,
      );
    }

    await sleep(backoff);
    backoff = Math.min(backoff * 2, __lockConfig.maxBackoffMs);
  }
}
