import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify, keyTerms, factCovered, collectFacts, RESTATEMENT_PROMPT } from "../src/commands/verify.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

function scaffold(): ReturnType<typeof resolveHandoffPaths> {
  const dir = mkdtempSync(join(tmpdir(), "handoff-verify-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(
    paths.task,
    "# Task\n\nBuild a portable session-state CLI so agents can hand off mid-task without re-explaining.\n",
  );
  writeFileSync(
    paths.corrections,
    "# Corrections\n" +
      ["2026-01-01", "2026-01-02", "2026-01-03"]
        .map(
          (d) =>
            `\n## ${d}T00:00:00Z\n\n**agent did:** used os.path\n\n**user said:** always prefer pathlib over os.path\n\n---\n`,
        )
        .join(""),
  );
  writeFileSync(
    paths.attempts,
    "# Attempts\n\n## 2026-02-01T00:00:00Z\n\n**tried:** parsing the transcript with a naive newline split\n\n**error:**\n\n```\nbroke on multi-line traces\n```\n\n**fix:** split on H2 headers\n\n---\n",
  );
  writeFileSync(
    paths.openLoops,
    "# Open Loops\n\n- [ ] validate the clipboard cascade on a real Linux desktop\n",
  );
  return paths;
}

function captureStdout(): { restore: () => void; text: () => string } {
  const orig = console.log;
  let buf = "";
  console.log = (...a: unknown[]) => {
    buf += a.join(" ") + "\n";
  };
  return { restore: () => { console.log = orig; }, text: () => buf };
}

test("keyTerms prefers distinctive bigrams over bare frequency", () => {
  const terms = keyTerms("always prefer pathlib over os.path when joining paths", 5);
  assert.ok(terms.some((t) => t.includes(" ")), "should surface at least one bigram");
  assert.ok(terms.some((t) => t.includes("pathlib")), "should keep the distinctive token");
});

test("factCovered needs a real overlap, not one incidental word", () => {
  const fact = { kind: "constraint" as const, label: "x", terms: ["pathlib", "prefer pathlib", "os path"] };
  assert.equal(factCovered(fact, "I will always prefer pathlib, never os.path"), true);
  assert.equal(factCovered(fact, "I'll get started on the refactor now"), false);
});

test("a fact with no distinctive terms cannot fail", () => {
  assert.equal(factCovered({ kind: "task", label: "x", terms: [] }, "anything"), true);
});

test("collectFacts picks up task, standing rule, failure and open loop", async () => {
  const facts = await collectFacts(scaffold());
  const kinds = new Set(facts.map((f) => f.kind));
  assert.ok(kinds.has("task"), "task fact missing");
  assert.ok(kinds.has("constraint"), "constraint fact missing");
  assert.ok(kinds.has("failure"), "failure fact missing");
  assert.ok(kinds.has("open-loop"), "open-loop fact missing");
  // The 3x pathlib correction should have promoted to a standing rule.
  assert.ok(
    facts.some((f) => f.kind === "constraint" && /standing rule/.test(f.label)),
    "repeated correction should surface as a standing rule",
  );
});

test("verify with no --check prints the restatement prompt", async () => {
  const paths = scaffold();
  const cap = captureStdout();
  try {
    await verify({ cwd: join(paths.dir, "..") });
    assert.match(cap.text(), /restate/i);
    assert.match(cap.text(), /handoff verify --check/);
  } finally {
    cap.restore();
  }
  assert.match(RESTATEMENT_PROMPT, /UNKNOWN/, "prompt should invite an explicit unknown");
});

test("a faithful restatement scores as complete", async () => {
  const paths = scaffold();
  const root = join(paths.dir, "..");
  const answer = join(root, "answer.md");
  writeFileSync(
    answer,
    `TASK: build a portable session-state CLI so agents hand off mid-task without re-explaining.
CONSTRAINTS: always prefer pathlib over os.path.
PRIOR FAILURES: parsing the transcript with a naive newline split broke on multi-line traces.
OPEN LOOPS: validate the clipboard cascade on a real Linux desktop.`,
  );
  const prev = process.exitCode;
  process.exitCode = 0;
  const cap = captureStdout();
  try {
    await verify({ check: true, file: answer, cwd: root });
    assert.match(cap.text(), /carried across: \d+\/\d+ facts/);
    assert.doesNotMatch(cap.text(), /looks incomplete/);
    assert.equal(process.exitCode, 0, "a faithful restatement must not fail");
  } finally {
    cap.restore();
    process.exitCode = prev;
  }
});

test("an empty-headed restatement is flagged and exits 1", async () => {
  const paths = scaffold();
  const root = join(paths.dir, "..");
  const answer = join(root, "bad.md");
  writeFileSync(answer, "Sure! I'm ready to help. What would you like me to work on?");
  const prev = process.exitCode;
  process.exitCode = 0;
  const cap = captureStdout();
  try {
    await verify({ check: true, file: answer, cwd: root });
    assert.match(cap.text(), /looks incomplete/);
    assert.match(cap.text(), /not reflected in the restatement/);
    assert.equal(process.exitCode, 1, "a hollow restatement must fail");
  } finally {
    cap.restore();
    process.exitCode = prev;
  }
});

test("verify --check on a missing file errors cleanly", async () => {
  const paths = scaffold();
  const prev = process.exitCode;
  process.exitCode = 0;
  const origErr = console.error;
  let stderr = "";
  console.error = (...a: unknown[]) => { stderr += a.join(" ") + "\n"; };
  try {
    await verify({ check: true, file: join(paths.dir, "nope.md"), cwd: join(paths.dir, "..") });
    assert.match(stderr, /file not found/);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = origErr;
    process.exitCode = prev;
  }
});

test("verify without .handoff/ tells the user to init", async () => {
  const empty = mkdtempSync(join(tmpdir(), "handoff-verify-empty-"));
  const prev = process.exitCode;
  process.exitCode = 0;
  const origErr = console.error;
  let stderr = "";
  console.error = (...a: unknown[]) => { stderr += a.join(" ") + "\n"; };
  try {
    await verify({ cwd: empty });
    assert.match(stderr, /handoff init/);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = origErr;
    process.exitCode = prev;
  }
});

test("open-loop facts carry real terms (bullets must be stripped first)", async () => {
  // Regression: the shared ngram extractor skips lines starting with a list
  // bullet, so passing the raw "- [ ] ..." line produced zero terms — and a
  // zero-term fact auto-passed, meaning open loops could never be flagged.
  const facts = await collectFacts(scaffold());
  const loops = facts.filter((f) => f.kind === "open-loop");
  assert.ok(loops.length > 0, "expected an open-loop fact");
  for (const loop of loops) {
    assert.ok(loop.terms.length > 0, `open-loop fact has no terms: ${loop.label}`);
  }
});

test("pure filler carries across nothing at all", async () => {
  const paths = scaffold();
  const root = join(paths.dir, "..");
  const answer = join(root, "filler.md");
  writeFileSync(answer, "Sure! Happy to help. What would you like me to work on today?");
  const prev = process.exitCode;
  process.exitCode = 0;
  const cap = captureStdout();
  try {
    await verify({ check: true, file: answer, cwd: root });
    assert.match(cap.text(), /carried across: 0\//, "filler must score zero, not partial credit");
  } finally {
    cap.restore();
    process.exitCode = prev;
  }
});
