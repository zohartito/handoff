import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

test("baseline measures partial input and replays in isolation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "handoff-baseline-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".handoff");
  mkdirSync(dir);
  writeFileSync(join(dir, "environment.md"), "");
  writeFileSync(join(dir, "attempts.md"), "## 2026-01-01T00:00:00Z\nprivate-é");

  const output = execFileSync(process.execPath, [
    resolve("scripts/measure-continuity.mjs"), root, resolve("tests/fixtures/auto-capture/session.jsonl"), "2", "9",
  ], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.files["attempts.md"].lines, 2);
  assert.equal(report.files["attempts.md"].records, 1);
  assert.equal(report.files["environment.md"].bytes, 0);
  assert.equal(report.files["task.md"], undefined);
  assert.ok(report.primer.lines > 0);
  assert.equal(report.replay["attempts.md"].records, 1);
  assert.equal(report.replay["corrections.md"].records, 1);
  assert.deepEqual(report.transcript.quoteInPrimer, { "2": false, "9": true });
  assert.doesNotMatch(output, /private-é/);
  assert.deepEqual(readdirSync(dir).sort(), ["attempts.md", "environment.md"]);
  assert.equal(readFileSync(join(dir, "attempts.md"), "utf8"), "## 2026-01-01T00:00:00Z\nprivate-é");
});
