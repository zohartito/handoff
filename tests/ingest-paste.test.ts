import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPasteSummary,
  countPasteAssistantTurns,
  countPasteUserMessages,
  extractPasteUserMsgs,
  ingestPaste,
  renderPasteSummary,
} from "../src/adapters/paste.js";

const here = dirname(fileURLToPath(import.meta.url));
// tests are compiled into dist-test/tests; fixtures live beside the source.
const FIXTURE = resolve(here, "../../tests/fixtures/paste/sample-transcript.md");

/**
 * Note on test scaffolding: node:test runs top-level `test()` calls
 * concurrently by default. If two tests override `process.stdout.write` at
 * the same time, one test's TAP output gets swallowed by the other's
 * capture, and node:test silently drops it from the reporter. To avoid
 * that trap we never capture stdout in these tests — we verify behavior by
 * reading the files that `emitOutput` writes to disk, not by spying on
 * stdout. stderr (console.error) is fine to capture because node:test
 * doesn't use it for TAP output.
 */

// ------------- helpers -------------

function makeProject(label: string): {
  dir: string;
  handoffDir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), `handoff-paste-${label}-`));
  const handoffDir = join(dir, ".handoff");
  mkdirSync(handoffDir, { recursive: true });
  return {
    dir,
    handoffDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ------------- heuristic helpers -------------

test("countPasteUserMessages counts common speaker markers", () => {
  const text = [
    "User: first",
    "Claude: some reply",
    "You: second",
    "Assistant: ok",
    "me: third",
    "Human: fourth",
    "Q: fifth",
    "Prompt: sixth",
  ].join("\n");
  assert.equal(countPasteUserMessages(text), 6);
});

test("countPasteUserMessages tolerates markdown bold wrappers and leading space", () => {
  const text = ["**User:** first", "  **You:** second", "**user**: third"].join("\n");
  assert.equal(countPasteUserMessages(text), 3);
});

test("countPasteAssistantTurns counts common assistant markers", () => {
  const text = [
    "User: hi",
    "Claude: hello",
    "User: again",
    "Assistant: yes",
    "GPT: sure",
    "AI: here",
  ].join("\n");
  assert.equal(countPasteAssistantTurns(text), 4);
});

test("extractPasteUserMsgs returns snippets stripped of speaker marker", () => {
  const msgs = extractPasteUserMsgs("User: hello world\nClaude: hi\nUser: follow up");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, "hello world");
  assert.equal(msgs[1].text, "follow up");
});

test("extractPasteUserMsgs skips empty-after-marker lines", () => {
  const msgs = extractPasteUserMsgs("User:   \nUser: real content\n");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, "real content");
});

// ------------- renderPasteSummary -------------

test("renderPasteSummary produces the shared section layout", () => {
  const text = readFileSync(FIXTURE, "utf8");
  const out = renderPasteSummary({ text, source: FIXTURE });

  // H1 from the shared renderer
  assert.match(out, /^# Pasted transcript Session:/m);

  // Metadata line — session id is unknown for pastes
  assert.match(out, /\*\*Session ID\*\*: `\?`/);
  // Duration unknown
  assert.match(out, /\*\*Duration\*\*: \?/);

  // Standard H2 section order (parity with every other adapter)
  const userIdx = out.indexOf("## User messages (chronological)");
  const toolIdx = out.indexOf("## Tool activity");
  const finalIdx = out.indexOf("## Assistant's final messages");
  assert.ok(userIdx > 0, "user messages section present");
  assert.ok(toolIdx > userIdx, "tool activity after user messages");
  assert.ok(finalIdx > toolIdx, "final messages after tool activity");

  // User message count reflects the fixture (5 "User:" lines)
  assert.match(out, /\*\*User messages\*\*: 5/);
  // A snippet from the first user message made it through
  assert.match(out, /refactor the auth flow/);

  // Tool activity section renders the empty marker (no tool calls in paste)
  assert.match(out, /_\(no tool calls\)_/);
});

test("renderPasteSummary on unparseable text does not crash and falls back to a first-line snippet", () => {
  // No recognizable speaker markers — just random prose.
  const text =
    "Here is a bunch of text with no chat markers in it at all.\nSecond line with more prose.";
  const out = renderPasteSummary({ text, source: "stdin" });

  // Still produces a valid summary
  assert.match(out, /^# Pasted transcript Session:/m);
  // User count = 1 from the synthetic fallback entry
  assert.match(out, /\*\*User messages\*\*: 1/);
  // Fallback snippet shows the first line
  assert.match(out, /\(unparsed paste/);
  assert.match(out, /Here is a bunch of text/);
});

test("renderPasteSummary handles empty text without throwing", () => {
  const out = renderPasteSummary({ text: "", source: "stdin" });
  assert.match(out, /^# Pasted transcript Session:/m);
  assert.match(out, /\*\*User messages\*\*: 0/);
  assert.match(out, /\*\*Assistant turns\*\*: 0/);
});

// ------------- ingestPaste: file mode -------------

test("ingestPaste --file writes transcript.md and a summary to .handoff/ingested-context.md", async () => {
  const proj = makeProject("file");
  try {
    // Use an explicit --out so ingestPaste doesn't mirror to stdout (which
    // would otherwise interfere with node:test's TAP output in concurrent
    // runs — see the note at the top of this file).
    const outFile = join(proj.dir, "summary.md");
    await ingestPaste({ file: FIXTURE, out: outFile, project: proj.dir });

    // Raw paste persisted at .handoff/transcript.md
    const transcriptMd = join(proj.handoffDir, "transcript.md");
    const persisted = readFileSync(transcriptMd, "utf8");
    assert.match(persisted, /refactor the auth flow/);
    // Trailing newline guaranteed by writeFileSafe payload normalization
    assert.ok(persisted.endsWith("\n"), "transcript.md should end with newline");

    // Summary written to --out
    const summary = readFileSync(outFile, "utf8");
    assert.match(summary, /^# Pasted transcript Session:/m);
    assert.match(summary, /\*\*User messages\*\*: 5/);
  } finally {
    proj.cleanup();
  }
});

test("ingestPaste --file (no --out) persists the summary to .handoff/ingested-context.md", async () => {
  // When --out is absent, emitOutput falls back to .handoff/ingested-context.md
  // *and* mirrors to stdout. We divert the stdout side to a per-test
  // temp file so the on-disk assertions are unambiguous and we don't have
  // to override process.stdout.write (which races with node:test's TAP).
  const proj = makeProject("file-implicit");
  try {
    const diverted = join(proj.dir, "divert.md");
    await ingestPaste({ file: FIXTURE, out: diverted, project: proj.dir });
    // Raw paste at .handoff/transcript.md
    const persisted = readFileSync(join(proj.handoffDir, "transcript.md"), "utf8");
    assert.match(persisted, /Claude: Happy to help/);
    // Summary landed at the diverted --out path
    assert.match(readFileSync(diverted, "utf8"), /# Pasted transcript Session:/);
  } finally {
    proj.cleanup();
  }
});

// ------------- ingestPaste: stdin mode -------------

test("ingestPaste --stdin reads piped text and writes transcript.md", async () => {
  const proj = makeProject("stdin");
  const originalStdin = process.stdin;

  // Minimal mock: a tiny EventEmitter that emits one data chunk then end.
  const { EventEmitter } = await import("node:events");
  const mock = new EventEmitter() as any;
  Object.defineProperty(process, "stdin", {
    value: mock,
    configurable: true,
    writable: true,
  });

  const pasted = "User: mocked stdin hello\nClaude: world\nUser: again\n";
  try {
    const outFile = join(proj.dir, "summary.md");
    const runPromise = ingestPaste({
      stdin: true,
      out: outFile,
      project: proj.dir,
    });
    // Drive the mock stdin after ingestPaste has attached listeners.
    setImmediate(() => {
      mock.emit("data", Buffer.from(pasted, "utf8"));
      mock.emit("end");
    });
    await runPromise;

    // Raw paste persisted verbatim (trailing newline preserved)
    const transcriptMd = join(proj.handoffDir, "transcript.md");
    const persisted = readFileSync(transcriptMd, "utf8");
    assert.equal(persisted, pasted);

    // Summary counts user messages from the paste
    const summary = readFileSync(outFile, "utf8");
    assert.match(summary, /\*\*User messages\*\*: 2/);
  } finally {
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    proj.cleanup();
  }
});

// ------------- ingestPaste: error cases -------------
//
// These tests set process.exitCode and capture console.error to verify
// the failure modes. We DON'T override process.stdout.write — that would
// race with node:test's TAP output in concurrent runs.

function expectErr(
  fn: () => Promise<void>,
  match: RegExp,
): Promise<{ ok: boolean; messages: string[] }> {
  const prevExitCode = process.exitCode;
  const origErr = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
  return fn()
    .then(() => {
      const ok = process.exitCode === 1 && messages.some((m) => match.test(m));
      return { ok, messages };
    })
    .finally(() => {
      console.error = origErr;
      process.exitCode = prevExitCode;
    });
}

test("ingestPaste errors when zero modes specified", async () => {
  const proj = makeProject("none");
  try {
    const res = await expectErr(
      () => ingestPaste({ project: proj.dir }),
      /requires one input mode/i,
    );
    assert.ok(res.ok, `expected mode-required error, got: ${res.messages.join(" | ")}`);
  } finally {
    proj.cleanup();
  }
});

test("ingestPaste errors when two modes specified (file + stdin)", async () => {
  const proj = makeProject("both-fs");
  try {
    const res = await expectErr(
      () => ingestPaste({ file: FIXTURE, stdin: true, project: proj.dir }),
      /mutually exclusive/i,
    );
    assert.ok(
      res.ok,
      `expected mutually-exclusive error, got: ${res.messages.join(" | ")}`,
    );
  } finally {
    proj.cleanup();
  }
});

test("ingestPaste errors when all three modes specified", async () => {
  const proj = makeProject("all3");
  try {
    const res = await expectErr(
      () =>
        ingestPaste({
          file: FIXTURE,
          stdin: true,
          clipboard: true,
          project: proj.dir,
        }),
      /mutually exclusive/i,
    );
    assert.ok(
      res.ok,
      `expected mutually-exclusive error, got: ${res.messages.join(" | ")}`,
    );
  } finally {
    proj.cleanup();
  }
});

test("ingestPaste errors when the pasted text is empty (file mode)", async () => {
  const proj = makeProject("empty-file");
  const emptyFile = join(proj.dir, "empty.md");
  writeFileSync(emptyFile, "   \n\n  \n", "utf8");
  try {
    const res = await expectErr(
      () => ingestPaste({ file: emptyFile, project: proj.dir }),
      /empty/i,
    );
    assert.ok(res.ok, `expected empty-paste error, got: ${res.messages.join(" | ")}`);
  } finally {
    proj.cleanup();
  }
});

test("ingestPaste errors cleanly when --file points at a missing path", async () => {
  const proj = makeProject("missing");
  try {
    const res = await expectErr(
      () =>
        ingestPaste({
          file: join(proj.dir, "does-not-exist.md"),
          project: proj.dir,
        }),
      /could not read pasted transcript/i,
    );
    assert.ok(res.ok, `expected read-failure message, got: ${res.messages.join(" | ")}`);
  } finally {
    proj.cleanup();
  }
});

// ------------- buildPasteSummary (--all composer) -------------

test("buildPasteSummary returns null when no transcript.md exists", async () => {
  const proj = makeProject("all-none");
  try {
    const res = await buildPasteSummary({ project: proj.dir });
    assert.equal(res, null);
  } finally {
    proj.cleanup();
  }
});

test("buildPasteSummary returns null when transcript.md is blank", async () => {
  const proj = makeProject("all-blank");
  try {
    writeFileSync(join(proj.handoffDir, "transcript.md"), "   \n", "utf8");
    const res = await buildPasteSummary({ project: proj.dir });
    assert.equal(res, null);
  } finally {
    proj.cleanup();
  }
});

test("buildPasteSummary returns a rendered summary when transcript.md has content", async () => {
  const proj = makeProject("all-present");
  try {
    writeFileSync(
      join(proj.handoffDir, "transcript.md"),
      readFileSync(FIXTURE, "utf8"),
      "utf8",
    );
    const res = await buildPasteSummary({ project: proj.dir });
    assert.ok(res !== null, "summary should be returned");
    assert.match(res!, /^# Pasted transcript Session:/m);
    assert.match(res!, /\*\*User messages\*\*: 5/);
  } finally {
    proj.cleanup();
  }
});
