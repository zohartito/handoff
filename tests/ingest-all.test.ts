import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitOutput,
  ingest,
  ingestAll,
  renderCombinedAll,
  type IngestAllSource,
} from "../src/commands/ingest.js";

/**
 * These tests exercise the `--all` orchestrator using stub adapters. We do
 * not hit the real Claude Code / Cursor / Codex / Gemini stores — the
 * per-adapter tests already cover those. Here we verify:
 *   - ordering of source sections
 *   - stub text for missing sources
 *   - per-source try/catch isolation
 *   - mutual exclusion of --all and --from
 */

const FAKE_PROJECT = "C:\\Users\\test\\proj";

function stubSources(
  bodies: Record<string, string | null | Error>,
): IngestAllSource[] {
  return [
    { label: "Claude Code", build: () => fabricate(bodies["Claude Code"]) },
    { label: "Cursor", build: () => fabricate(bodies["Cursor"]) },
    { label: "Codex", build: () => fabricate(bodies["Codex"]) },
    { label: "Gemini", build: () => fabricate(bodies["Gemini"]) },
  ];
}

async function fabricate(val: string | null | Error | undefined): Promise<string | null> {
  if (val instanceof Error) throw val;
  if (val === undefined) return null;
  return val;
}

test("renderCombinedAll: all four sources present, emits top header and sections in fixed order", async () => {
  const sources = stubSources({
    "Claude Code": "# Claude Code Session: abc11111\n\nclaude body",
    "Cursor": "# Cursor Session: cur22222\n\ncursor body",
    "Codex": "# Codex Session: cod33333\n\ncodex body",
    "Gemini": "# Gemini Session: gem44444\n\ngemini body",
  });

  const out = await renderCombinedAll(FAKE_PROJECT, sources);

  // Top-level header + project line
  assert.match(out, /^# Handoff Ingest — All Sources/m);
  assert.match(out, /\*\*Project\*\*: `C:\\Users\\test\\proj`/);

  // All four source bodies made it through
  assert.match(out, /# Claude Code Session: abc11111/);
  assert.match(out, /# Cursor Session: cur22222/);
  assert.match(out, /# Codex Session: cod33333/);
  assert.match(out, /# Gemini Session: gem44444/);

  // Fixed order: Claude Code → Cursor → Codex → Gemini
  const claudeIdx = out.indexOf("# Claude Code Session: abc11111");
  const cursorIdx = out.indexOf("# Cursor Session: cur22222");
  const codexIdx = out.indexOf("# Codex Session: cod33333");
  const geminiIdx = out.indexOf("# Gemini Session: gem44444");
  assert.ok(claudeIdx > 0 && cursorIdx > claudeIdx && codexIdx > cursorIdx && geminiIdx > codexIdx,
    `sections out of order: claude=${claudeIdx} cursor=${cursorIdx} codex=${codexIdx} gemini=${geminiIdx}`);

  // Separators: 4 `\n\n---\n\n` between (1 header block + 4 bodies) = 4 separators total
  const sepCount = (out.match(/\n\n---\n\n/g) ?? []).length;
  assert.equal(sepCount, 4, "expected exactly 4 separator lines (header + 4 bodies)");
});

test("renderCombinedAll: missing sources render the empty-state stub", async () => {
  // Cursor returns null (no session); others have content
  const sources = stubSources({
    "Claude Code": "# Claude Code Session: abc11111\n\nclaude body",
    "Cursor": null,
    "Codex": "# Codex Session: cod33333\n\ncodex body",
    "Gemini": null,
  });

  const out = await renderCombinedAll(FAKE_PROJECT, sources);

  // Present sources still appear
  assert.match(out, /# Claude Code Session: abc11111/);
  assert.match(out, /# Codex Session: cod33333/);

  // Missing sources appear as stub sections, NOT as empty gaps
  assert.match(out, /## Cursor\n\n_\(no recent session found for this project\)_/);
  assert.match(out, /## Gemini\n\n_\(no recent session found for this project\)_/);

  // Document still has all four sections, in order
  const claudeIdx = out.indexOf("# Claude Code Session: abc11111");
  const cursorIdx = out.indexOf("## Cursor\n\n_(no recent session");
  const codexIdx = out.indexOf("# Codex Session: cod33333");
  const geminiIdx = out.indexOf("## Gemini\n\n_(no recent session");
  assert.ok(claudeIdx > 0 && cursorIdx > claudeIdx && codexIdx > cursorIdx && geminiIdx > codexIdx,
    "order preserved even when some sources are stubbed");
});

test("renderCombinedAll: a throwing adapter does not break the rest of the run", async () => {
  const sources = stubSources({
    "Claude Code": "# Claude Code Session: abc11111\n\nclaude body",
    "Cursor": new Error("sqlite read failed"),
    "Codex": "# Codex Session: cod33333\n\ncodex body",
    "Gemini": null,
  });

  const out = await renderCombinedAll(FAKE_PROJECT, sources);

  // The survivors still render
  assert.match(out, /# Claude Code Session: abc11111/);
  assert.match(out, /# Codex Session: cod33333/);
  // Gemini empty stub
  assert.match(out, /## Gemini\n\n_\(no recent session found for this project\)_/);
  // Cursor becomes an adapter-failed stub, carrying the error message
  assert.match(out, /## Cursor\n\n_\(adapter failed: sqlite read failed\)_/);
});

test("ingestAll writes the combined document to --out and accepts a sources override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-ingest-all-"));
  const outFile = join(dir, "combined.md");
  try {
    const sources = stubSources({
      "Claude Code": "# Claude Code Session: abc11111\n\nclaude body",
      "Cursor": "# Cursor Session: cur22222\n\ncursor body",
      "Codex": "# Codex Session: cod33333\n\ncodex body",
      "Gemini": "# Gemini Session: gem44444\n\ngemini body",
    });
    await ingestAll(FAKE_PROJECT, outFile, sources);
    const written = readFileSync(outFile, "utf8");
    assert.match(written, /^# Handoff Ingest — All Sources/m);
    assert.match(written, /# Claude Code Session: abc11111/);
    assert.match(written, /# Gemini Session: gem44444/);
    // Output file always ends with a trailing newline
    assert.ok(written.endsWith("\n"), "output file should end with newline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitOutput mirrors to stdout and persists to .handoff/ingested-context.md when present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-emit-output-"));
  const handoffDir = join(dir, ".handoff");
  mkdirSync(handoffDir, { recursive: true });

  const originalWrite = process.stdout.write;
  let printed = "";
  (process.stdout as any).write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    await emitOutput("# Imported\n", undefined, dir);
    const persisted = readFileSync(join(handoffDir, "ingested-context.md"), "utf8");
    assert.equal(persisted, "# Imported\n");
    assert.match(printed, /# Imported/);
  } finally {
    (process.stdout as any).write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingest: --all and --from together errors out and sets a non-zero exit code", async () => {
  const prev = process.exitCode;
  process.exitCode = 0;
  const origErr = console.error;
  const errMsgs: string[] = [];
  console.error = (...args: unknown[]) => {
    errMsgs.push(args.map(String).join(" "));
  };
  try {
    await ingest({
      from: "cursor",
      all: true,
      project: FAKE_PROJECT,
    });
    assert.equal(process.exitCode, 1, "exitCode set to 1 on conflict");
    assert.ok(
      errMsgs.some((m) => /mutually exclusive/i.test(m)),
      `expected a mutually-exclusive error message, got: ${errMsgs.join(" | ")}`,
    );
  } finally {
    console.error = origErr;
    process.exitCode = prev;
  }
});
