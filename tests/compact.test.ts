import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compact, compactLog, parseLog } from "../src/commands/compact.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

// --- helpers ----------------------------------------------------------------

const HEADER = `# Attempts

<!-- guidance comment that must survive compaction -->
`;

/** Build one append-only entry block in the on-disk format. */
function entry(ts: string, tried: string, error?: string): string {
  const lines = [`## ${ts}`, ``, `**tried:** ${tried}`];
  if (error) lines.push(``, `**error:**`, ``, "```", error, "```");
  lines.push(``, `---`, ``);
  return lines.join("\n");
}

function withSilencedStdout<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  return fn().finally(() => {
    console.log = origLog;
    console.error = origErr;
  });
}

function scaffold(attempts: string): string {
  const root = mkdtempSync(join(tmpdir(), "handoff-compact-"));
  const paths = resolveHandoffPaths(root);
  mkdirSync(paths.dir, { recursive: true });
  // meta.json marks it a real project; keep the other logs empty.
  writeFileSync(paths.meta, JSON.stringify({ schemaVersion: 1 }));
  writeFileSync(paths.attempts, attempts);
  writeFileSync(paths.corrections, "# Corrections\n");
  writeFileSync(paths.decisions, "# Decisions\n");
  return root;
}

// --- 1: identical entries collapse into one with a count --------------------

test("dedupe: nine identical failures collapse to one entry with a 9x count", () => {
  const dup = "hit Claude Code rate limit";
  const err = "rate_limit error — session blocked";
  let body = HEADER;
  for (let i = 1; i <= 9; i++) {
    body += entry(`2026-08-0${Math.min(i, 9)}T0${i % 9}:00:00.000Z`, dup, err);
  }

  const { output, stats } = compactLog(body);
  assert.equal(stats.inputEvents, 9);
  assert.equal(stats.distinct, 1);
  assert.equal(stats.merged, 8);

  const seen = output.match(/\*\*seen:\*\*\s*(\d+)×/);
  assert.ok(seen, "provenance line present");
  assert.equal(seen![1], "9");
  // The failure text appears exactly once now.
  assert.equal(output.split(dup).length - 1, 1);
  // First + last timestamps preserved in provenance.
  assert.match(output, /first 2026-08-01T01:00:00\.000Z/);
});

// --- 2: distinct entries are all preserved ----------------------------------

test("distinct entries survive; nothing load-bearing is dropped", () => {
  const body =
    HEADER +
    entry("2026-08-01T00:00:00.000Z", "approach A", "error A") +
    entry("2026-08-02T00:00:00.000Z", "approach B", "error B") +
    entry("2026-08-03T00:00:00.000Z", "approach A", "error A"); // dup of first

  const { output, stats } = compactLog(body);
  assert.equal(stats.inputEvents, 3);
  assert.equal(stats.distinct, 2);
  assert.match(output, /approach A/);
  assert.match(output, /approach B/);
  assert.match(output, /error B/);
  // guidance comment preserved
  assert.match(output, /guidance comment that must survive/);
});

// --- 3: archive fold bounds the live set ------------------------------------

test("entries beyond --keep are relocated verbatim into an Archive section", () => {
  let body = HEADER;
  for (let i = 1; i <= 5; i++) {
    body += entry(`2026-08-0${i}T00:00:00.000Z`, `distinct approach ${i}`);
  }

  const { output, stats } = compactLog(body, { keep: 2, now: new Date("2026-08-10T00:00:00Z") });
  assert.equal(stats.distinct, 5);
  assert.equal(stats.archived, 3);

  const archiveIdx = output.indexOf("## Archive");
  assert.ok(archiveIdx > 0, "archive section exists");
  // Newest two are above the fold; oldest three below it.
  assert.ok(output.indexOf("distinct approach 4") < archiveIdx);
  assert.ok(output.indexOf("distinct approach 5") < archiveIdx);
  assert.ok(output.indexOf("distinct approach 1") > archiveIdx);
  assert.ok(output.indexOf("distinct approach 3") > archiveIdx);
});

// --- 4: idempotence ---------------------------------------------------------

test("compaction is idempotent: compact(compact(x)) == compact(x)", () => {
  let body = HEADER;
  body += entry("2026-08-01T00:00:00.000Z", "dup", "boom");
  body += entry("2026-08-02T00:00:00.000Z", "dup", "boom");
  for (let i = 3; i <= 8; i++) body += entry(`2026-08-0${i}T00:00:00.000Z`, `approach ${i}`);

  const once = compactLog(body, { keep: 3, now: new Date("2026-08-10T00:00:00Z") }).output;
  const twice = compactLog(once, { keep: 3, now: new Date("2026-08-10T00:00:00Z") }).output;
  assert.equal(twice, once);
  // Re-parsing the compacted output still finds the merged count.
  const reparsed = parseLog(once).entries.find((e) => e.body.includes("dup"));
  assert.equal(reparsed?.count, 2);
});

// --- 5: files with no timestamped entries are left untouched ----------------

test("a template-only log is skipped, not rewritten", async () => {
  const root = scaffold("# Attempts\n\n<!-- just a header -->\n");
  try {
    const before = readFileSync(resolveHandoffPaths(root).attempts, "utf8");
    const results = await withSilencedStdout(() =>
      compact({ cwd: root, targets: ["attempts"], quiet: true }),
    );
    assert.equal(results[0].skipped, true);
    assert.equal(readFileSync(resolveHandoffPaths(root).attempts, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 6: end-to-end write + dry-run ------------------------------------------

test("compact writes the deduped file; --dry-run leaves it untouched", async () => {
  const dupBody =
    HEADER +
    entry("2026-08-01T00:00:00.000Z", "rate limit", "boom") +
    entry("2026-08-02T00:00:00.000Z", "rate limit", "boom");

  // dry-run: no write
  const root1 = scaffold(dupBody);
  try {
    await withSilencedStdout(() => compact({ cwd: root1, targets: ["attempts"], dryRun: true, quiet: true }));
    assert.equal(readFileSync(resolveHandoffPaths(root1).attempts, "utf8"), dupBody);
  } finally {
    rmSync(root1, { recursive: true, force: true });
  }

  // real run: file shrinks to one entry
  const root2 = scaffold(dupBody);
  try {
    const results = await withSilencedStdout(() => compact({ cwd: root2, targets: ["attempts"], quiet: true }));
    assert.equal(results[0].changed, true);
    assert.equal(results[0].merged, 1);
    const after = readFileSync(resolveHandoffPaths(root2).attempts, "utf8");
    assert.equal(after.split("rate limit").length - 1, 1);
    assert.match(after, /\*\*seen:\*\*\s*2×/);
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});
