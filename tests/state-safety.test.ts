import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOrEmpty, readJson, appendLine, writeFileSafe, writeJson } from "../src/util/fs.js";
import { withFileLock } from "../src/util/lock.js";

test("HOF-08: state helpers reject symlink reads writes and lock traversal", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "handoff-symlink-"));
  const state = join(root, "project", ".handoff");
  const outside = join(root, "outside");
  await fs.mkdir(state, { recursive: true });
  await fs.mkdir(outside);
  const victim = join(outside, "victim");
  await fs.writeFile(victim, '{"marker":"OUTSIDE_STATE"}');
  const target = join(state, "attempts.md");
  try { await fs.symlink(victim, target); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable");
    throw err;
  }
  for (const operation of [
    () => readOrEmpty(target), () => readJson(target),
    () => appendLine(target, "append"), () => writeFileSafe(target, "overwrite"),
    () => writeJson(target, {}), () => withFileLock(target, async () => {}),
  ]) await assert.rejects(operation, /unsafe.*state|symlink/i);
  assert.equal(await fs.readFile(victim, "utf8"), '{"marker":"OUTSIDE_STATE"}');
  await fs.symlink(outside, join(state, "nested"), "dir");
  await assert.rejects(() => writeFileSafe(join(state, "nested", "new"), "bad"), /unsafe.*state|symlink/i);
  await fs.symlink(outside, join(root, ".handoff"), "dir");
  await assert.rejects(() => readOrEmpty(join(root, ".handoff", "victim")), /unsafe.*state|symlink/i);
});
