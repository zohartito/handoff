import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, extractMarkers } from "../src/commands/capture.js";

const here = dirname(fileURLToPath(import.meta.url));
// `here` at runtime is dist-test/tests/ — fixtures live next to the source at tests/fixtures/
const FIXTURE = resolve(here, "../../tests/fixtures/capture/transcript-with-markers.md");

function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-capture-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  return dir;
}

function streamFromString(s: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(s, "utf8")]);
}

/** Swallow stdout/stderr from an async block so test output stays clean. */
async function silent<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

// --- extractMarkers: pure function -----------------------------------------

test("extractMarkers picks up DECISION/TODO/CORRECTION/TASK lines, ignores prose", () => {
  const transcript = readFileSync(FIXTURE, "utf8");
  const out = extractMarkers(transcript);

  assert.equal(out.task.length, 1);
  assert.match(out.task[0]!, /implement `handoff capture` end-of-session/);

  assert.equal(out.decision.length, 2);
  assert.match(out.decision[0]!, /transcript\.md/);
  assert.match(out.decision[1]!, /case-insensitive/);

  assert.equal(out.correction.length, 1);
  assert.match(out.correction[0]!, /do not overwrite/);

  assert.equal(out.todo.length, 2);
  assert.match(out.todo[0]!, /--dry-run/);
  assert.match(out.todo[1]!, /README/);
});

test("extractMarkers is case-insensitive and tolerates list-bullet prefixes", () => {
  const transcript = [
    "decision: lowercase should still match",
    "- TODO: inside a list bullet",
    "  * Correction: nested bullet, mixed case",
    "regular prose about a decision: that is not a marker", // not at line start
    "TASK:", // empty content — must be ignored
  ].join("\n");
  const out = extractMarkers(transcript);
  assert.equal(out.decision.length, 1);
  assert.match(out.decision[0]!, /lowercase should still match/);
  assert.equal(out.todo.length, 1);
  assert.match(out.todo[0]!, /inside a list bullet/);
  assert.equal(out.correction.length, 1);
  assert.match(out.correction[0]!, /nested bullet/);
  assert.equal(out.task.length, 0, "empty TASK: line must be skipped");
});

// --- capture command: full mode --------------------------------------------

test("capture --mode full: writes transcript and extracts markers into correct files", async () => {
  const cwd = makeTmpProject();
  try {
    const transcript = readFileSync(FIXTURE, "utf8");
    await silent(() =>
      capture({
        source: { kind: "stdin" },
        mode: "full",
        cwd,
        stdin: streamFromString(transcript),
      }),
    );

    const transcriptPath = join(cwd, ".handoff", "transcript.md");
    const decisionsPath = join(cwd, ".handoff", "decisions.md");
    const correctionsPath = join(cwd, ".handoff", "corrections.md");
    const taskPath = join(cwd, ".handoff", "task.md");
    const progressPath = join(cwd, ".handoff", "progress.md");

    assert.ok(existsSync(transcriptPath), "transcript.md should exist");
    const transcriptBody = readFileSync(transcriptPath, "utf8");
    assert.match(transcriptBody, /# Session transcript/);
    assert.match(transcriptBody, /## Session \d{4}-\d{2}-\d{2}T/);
    // The full transcript content must be preserved verbatim.
    assert.ok(
      transcriptBody.includes("TASK: implement `handoff capture` end-of-session command"),
      "raw transcript body must be written unchanged",
    );

    const decisions = readFileSync(decisionsPath, "utf8");
    assert.match(decisions, /transcript\.md/);
    assert.match(decisions, /case-insensitive/);
    assert.match(decisions, /captured decisions/);

    const corrections = readFileSync(correctionsPath, "utf8");
    assert.match(corrections, /do not overwrite/);
    assert.match(corrections, /captured corrections/);

    const task = readFileSync(taskPath, "utf8");
    assert.match(task, /implement `handoff capture`/);

    const progress = readFileSync(progressPath, "utf8");
    assert.match(progress, /--dry-run/);
    assert.match(progress, /README/);
    assert.match(progress, /captured todos/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- capture command: summary mode -----------------------------------------

test("capture --mode summary: only transcript.md is written", async () => {
  const cwd = makeTmpProject();
  try {
    const transcript = readFileSync(FIXTURE, "utf8");
    await silent(() =>
      capture({
        source: { kind: "stdin" },
        mode: "summary",
        cwd,
        stdin: streamFromString(transcript),
      }),
    );

    const transcriptPath = join(cwd, ".handoff", "transcript.md");
    assert.ok(existsSync(transcriptPath), "transcript.md should exist");

    // None of the extraction targets should have been touched.
    for (const name of ["decisions.md", "corrections.md", "task.md", "progress.md"]) {
      assert.equal(
        existsSync(join(cwd, ".handoff", name)),
        false,
        `${name} must not be created in summary mode`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- append safety ---------------------------------------------------------

test("capture: two runs produce two Session sections, not overwrite", async () => {
  const cwd = makeTmpProject();
  try {
    await silent(() =>
      capture({
        source: { kind: "stdin" },
        mode: "summary",
        cwd,
        stdin: streamFromString("first session content\n"),
      }),
    );
    // Spin briefly so ISO timestamps differ between the two runs (ms precision).
    await new Promise((r) => setTimeout(r, 5));
    await silent(() =>
      capture({
        source: { kind: "stdin" },
        mode: "summary",
        cwd,
        stdin: streamFromString("second session content\n"),
      }),
    );

    const body = readFileSync(join(cwd, ".handoff", "transcript.md"), "utf8");
    const sessionHeaders = body.match(/^## Session /gm) ?? [];
    assert.equal(sessionHeaders.length, 2, "must have exactly 2 session headers");
    const separators = body.match(/^---$/gm) ?? [];
    assert.ok(separators.length >= 2, "must have at least two '---' separators");
    assert.ok(body.includes("first session content"), "first session retained");
    assert.ok(body.includes("second session content"), "second session present");
    // Ordering: first must appear before second.
    assert.ok(
      body.indexOf("first session content") < body.indexOf("second session content"),
      "sessions must be in chronological order",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- source-selection errors ----------------------------------------------

test("capture: from-file source reads the specified file", async () => {
  const cwd = makeTmpProject();
  const srcFile = join(cwd, "raw-transcript.md");
  writeFileSync(srcFile, "TASK: from file\nDECISION: chose A over B\n", "utf8");
  try {
    await silent(() =>
      capture({
        source: { kind: "file", path: srcFile },
        mode: "full",
        cwd,
      }),
    );
    const decisions = readFileSync(join(cwd, ".handoff", "decisions.md"), "utf8");
    assert.match(decisions, /chose A over B/);
    const task = readFileSync(join(cwd, ".handoff", "task.md"), "utf8");
    assert.match(task, /from file/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("capture: missing source file errors cleanly (non-zero exit, no crash)", async () => {
  const cwd = makeTmpProject();
  const originalExit = process.exitCode;
  process.exitCode = 0;
  let errText = "";
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    errText += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
  };
  try {
    await capture({
      source: { kind: "file", path: join(cwd, "does-not-exist.md") },
      mode: "full",
      cwd,
    });
    assert.equal(process.exitCode, 1, "must set exitCode=1 on missing file");
    assert.match(errText, /transcript file not found/);
  } finally {
    console.error = origErr;
    process.exitCode = originalExit;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("capture: uninitialized .handoff errors with a clear hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-capture-uninit-"));
  const originalExit = process.exitCode;
  process.exitCode = 0;
  let errText = "";
  const origErr = console.error;
  console.error = (...args: unknown[]) => {
    errText += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
  };
  try {
    await capture({
      source: { kind: "stdin" },
      mode: "summary",
      cwd: dir,
      stdin: streamFromString("anything"),
    });
    assert.equal(process.exitCode, 1);
    assert.match(errText, /\.handoff\/ not initialized/);
  } finally {
    console.error = origErr;
    process.exitCode = originalExit;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- override targets (for testing / alternate files) ----------------------

test("capture: --task/--decisions/--corrections overrides redirect writes", async () => {
  const cwd = makeTmpProject();
  const altTask = join(cwd, "alt-task.md");
  const altDecisions = join(cwd, "alt-decisions.md");
  const altCorrections = join(cwd, "alt-corrections.md");
  try {
    const transcript = readFileSync(FIXTURE, "utf8");
    await silent(() =>
      capture({
        source: { kind: "stdin" },
        mode: "full",
        cwd,
        taskPath: altTask,
        decisionsPath: altDecisions,
        correctionsPath: altCorrections,
        stdin: streamFromString(transcript),
      }),
    );

    assert.ok(existsSync(altTask));
    assert.ok(existsSync(altDecisions));
    assert.ok(existsSync(altCorrections));
    // Default paths must NOT have been created under .handoff/.
    assert.equal(
      existsSync(join(cwd, ".handoff", "task.md")),
      false,
      "default task.md must not be written when --task overrides",
    );
    assert.equal(
      existsSync(join(cwd, ".handoff", "decisions.md")),
      false,
      "default decisions.md must not be written when --decisions overrides",
    );
    assert.equal(
      existsSync(join(cwd, ".handoff", "corrections.md")),
      false,
      "default corrections.md must not be written when --corrections overrides",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
