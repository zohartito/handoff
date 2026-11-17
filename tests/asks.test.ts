import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { capturePrompt, fileAsk, readAsks, reconcileCommits } from "../src/commands/asks.js";
import { hook } from "../src/commands/hook.js";
import { isSideAsk } from "../src/commands/ask-detection.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "handoff-asks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveHandoffPaths(root);
  mkdirSync(paths.dir);
  return paths;
}

function cli(cwd: string, args: string[], input = "") {
  return execFileSync(process.execPath, [resolve("bin/handoff.mjs"), ...args], { cwd, input, encoding: "utf8" });
}

test("submit captures the original words and provenance, including continuation lines", t => {
  const paths = fixture(t);
  const legacy = "# Open loops\n\n- [ ] existing prose without a final newline";
  writeFileSync(paths.openLoops, legacy);
  const prompt = "Also add the diagram.  \r\n\n  Preserve <!-- THESE words -->.\n- [ ] not another loop\n";
  const payload = JSON.stringify({ cwd: paths.root, session_id: "s/123", prompt });
  assert.equal(cli(paths.root, ["hook", "user-prompt-submit"], payload), "");
  assert.equal(cli(paths.root, ["hook", "user-prompt-submit"], payload), "");
  const markdown = readFileSync(paths.openLoops, "utf8");
  const asks = readAsks(markdown);
  assert.ok(markdown.startsWith(legacy));
  assert.equal(asks.length, 1);
  assert.equal(asks[0].prompt, prompt);
  assert.equal(asks[0].session, "s/123");
  assert.ok(Number.isFinite(Date.parse(asks[0].date)));
  assert.match(markdown, /claude-code/);
  for (const args of [["prime"], ["prime", "--compact"]]) {
    const primer = cli(paths.root, args);
    assert.ok(primer.includes("Preserve <!-- THESE words -->."));
    assert.ok(!primer.includes("<!-- end handoff ask -->"));
  }
});

test("current-task questions, quoted instructions and status do not create loops", () => {
  for (const prompt of ["I want to understand what this means.", "The report also looks good.",
    "Did it also generate a diagram?", "Please do not also create a test.", "Can you make a chart?",
    "She wrote: \"Also add an index.\"", "> Also add the inventory.\nLooks good.",
    "Review this excerpt:\n```txt\nAlso add a timer.\n```", "<system-reminder>Also add tests</system-reminder>"]) {
    assert.equal(isSideAsk(prompt, false), false, prompt);
  }
});

test("explicit Linear and user receipts remove only the identified ask", async t => {
  const p = fixture(t);
  const note = "# My notes\n- [ ] old manual row\n";
  writeFileSync(p.openLoops, note);
  const first = "Also create a table.";
  await Promise.all([first, first, "Don't forget to check totals."].map(x => capturePrompt(p, x, "s", true, x)));
  const a = readAsks(readFileSync(p.openLoops, "utf8"));
  assert.equal(a.length, 2);
  const id = a.find(x => x.prompt === first)!.id;
  for (const msg of ["That open loop is done.", "This mentions ZOH-22.", "Don't close " + id]) {
    await capturePrompt(p, msg, "s", true);
  }
  assert.equal(readAsks(readFileSync(p.openLoops, "utf8")).length, 2);
  cli(p.root, ["resolve", id, "--issue", "ZOH-22"]);
  await fileAsk(p, id, "ZOH-22"); // retry
  await capturePrompt(p, first, "s", true, first); // redelivered capture
  await capturePrompt(p, "That open loop is done.", "other-session", true);
  assert.equal(readAsks(readFileSync(p.openLoops, "utf8")).length, 1);
  await capturePrompt(p, "That open loop is done.", "s", true);
  assert.equal(readAsks(readFileSync(p.openLoops, "utf8")).length, 0);
  assert.ok(readFileSync(p.openLoops, "utf8").startsWith(note));
  const receipts = readFileSync(join(p.dir, "ask-history.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts[0].evidence, { kind: "linear", value: "ZOH-22" });
  assert.equal(receipts[0].prompt, first);
  assert.equal(receipts[1].evidence.kind, "user");
  await capturePrompt(p, first, "s", true, "new-event");
  const [again] = readAsks(readFileSync(p.openLoops, "utf8"));
  assert.notEqual(again.id, id);
  await capturePrompt(p, `Filed ${again.id} as ZOH-51`, "s", true);
  assert.equal(readAsks(readFileSync(p.openLoops, "utf8")).length, 0);
});

test("retry between the receipt write and active-file replacement retains one receipt", async t => {
  const p = fixture(t);
  await capturePrompt(p, "Also write a summary.", "s", true);
  const before = readFileSync(p.openLoops, "utf8");
  const [{ id }] = readAsks(before);
  await fileAsk(p, id, "ZOH-22");
  const receiptPath = join(p.dir, "ask-history.jsonl");
  const receipt = readFileSync(receiptPath, "utf8");
  // Reproduce the exact on-disk state if the process exits between renames.
  writeFileSync(p.openLoops, before);
  await fileAsk(p, id, "ZOH-22");
  assert.equal(readFileSync(receiptPath, "utf8"), receipt);
  assert.deepEqual(readAsks(readFileSync(p.openLoops, "utf8")), []);
});

test("only a reachable resolving trailer closes an ask on Stop", async t => {
  const p = fixture(t);
  const env = { ...process.env };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd: p.root, encoding: "utf8", env }).trim();
  git("init", "-q", "-b", "main");
  await capturePrompt(p, "Also write a report.", "s", true);
  const [{ id }] = readAsks(readFileSync(p.openLoops, "utf8"));
  env.GIT_COMMITTER_DATE = "2004-01-01T00:00:00Z";
  git("commit", "--allow-empty", "-m", "Old trailer", "-m", "Resolves-Ask: " + id);
  delete env.GIT_COMMITTER_DATE;
  git("commit", "--allow-empty", "-m", "Discuss " + id);
  git("checkout", "-q", "-b", "side");
  git("commit", "--allow-empty", "-m", "Unmerged result", "-m", "Resolves-Ask: " + id);
  git("checkout", "-q", "main");
  await reconcileCommits(p);
  assert.equal(readAsks(readFileSync(p.openLoops, "utf8")).length, 1);
  git("commit", "--allow-empty", "-m", "Complete report", "-m", "Resolves-Ask: " + id);
  cli(p.root, ["hook", "stop"], JSON.stringify({ cwd: p.root }));
  assert.equal(readAsks(readFileSync(p.openLoops, "utf8")).length, 0);
  const receipt = JSON.parse(readFileSync(join(p.dir, "ask-history.jsonl"), "utf8"));
  assert.deepEqual(receipt.evidence, { kind: "commit", value: git("rev-parse", "HEAD") });
});

type Label = { prompt: string; expected: boolean; split: string; inFlight: boolean; session: string; line: number };
const defaultFixture = join(homedir(), ".local", "share", "handoff", "evals", "asks-labelled-with-context-2026-11.json");
const privateFixture = process.env.HANDOFF_ASK_FIXTURE ?? (existsSync(defaultFixture) ? defaultFixture : undefined);
test("real prompt capture meets precision and recall thresholds", { skip: !privateFixture }, async t => {
  const rows: Label[] = JSON.parse(readFileSync(privateFixture!, "utf8"));
  const sessions = new Map<string, string>();
  const sourceLines = new Set<string>();
  for (const row of rows) {
    assert.ok(["development", "evaluation"].includes(row.split));
    assert.equal(typeof row.expected, "boolean");
    assert.equal(typeof row.inFlight, "boolean");
    assert.ok(row.session && typeof row.prompt === "string" && Number.isInteger(row.line));
    assert.equal(sessions.get(row.session) ?? row.split, row.split, "splits must use distinct sessions");
    sessions.set(row.session, row.split);
    const key = JSON.stringify([row.session, row.line]);
    assert.ok(!sourceLines.has(key), "each source turn must be unique");
    sourceLines.add(key);
  }
  let meetsTarget = true;
  for (const split of ["development", "evaluation"]) {
    const sample = rows.filter(row => row.split === split);
    assert.ok(sample.length && sample.some(r => r.expected) && sample.some(r => !r.expected));
    const p = fixture(t);
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const row of sample) {
      // A fresh file isolates classification from lifecycle dedup across turns.
      rmSync(p.openLoops, { force: true });
      const sessions = row.inFlight ? { [row.session]: { lastLineProcessed: row.line - 1, lastMtimeMs: 1 } } : {};
      writeFileSync(p.captureState, JSON.stringify({ version: 1, sessions, seenHashes: [] }));
      await hook({ event: "user-prompt-submit", payload: { cwd: p.root, prompt: row.prompt, session_id: row.session } });
      const asks = existsSync(p.openLoops) ? readAsks(readFileSync(p.openLoops, "utf8")) : [];
      assert.ok(asks.length <= 1, "a submission must produce at most one quote");
      if (asks.length) assert.equal(asks[0].prompt, row.prompt, "captured turn must be verbatim");
      const captured = asks.length === 1;
      if (row.expected) { if (captured) tp++; else fn++; }
      else { if (captured) fp++; else tn++; }
    }
    const precision = tp / (tp + fp || 1), recall = tp / (tp + fn);
    console.log(`ask-eval ${split} n=${sample.length} TP=${tp} FP=${fp} FN=${fn} TN=${tn} precision=${(100 * precision).toFixed(1)}% recall=${(100 * recall).toFixed(1)}%`);
    meetsTarget &&= precision >= 0.8 && recall >= 0.9;
  }
  assert.ok(meetsTarget, "minimum precision 80% and recall 90% on each split");
});
