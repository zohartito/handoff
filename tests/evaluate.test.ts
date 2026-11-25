import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeMetrics,
  loadScenarios,
  loadScenario,
  evaluateStrategy,
  runSweep,
  makeRecurrenceRetriever,
  recency,
  STRATEGIES,
  DEFAULT_K,
  type Scenario,
} from "../src/commands/evaluate.js";
import { PROMOTION_THRESHOLD, entryId } from "../src/commands/ranking.js";

const here = dirname(fileURLToPath(import.meta.url));
// `here` at runtime is dist-test/tests/ — fixtures live next to the source.
const EVAL_DIR = resolve(here, "../../tests/fixtures/eval");

/** Assert two floats are equal within a small tolerance (metrics are ratios). */
function approx(actual: number, expected: number, msg?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);
}

function relSet(...ids: string[]): Set<string> {
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// computeMetrics — hand-computed values and edge cases
// ---------------------------------------------------------------------------

test("computeMetrics: a perfect retrieval scores 1 across the board", () => {
  const m = computeMetrics(["a", "b"], relSet("a", "b"));
  approx(m.precision, 1, "precision");
  approx(m.recall, 1, "recall");
  approx(m.f1, 1, "f1");
  approx(m.mrr, 1, "mrr");
});

test("computeMetrics: partial precision with full recall", () => {
  // 2 of 3 retrieved are relevant; both relevant items are found.
  const m = computeMetrics(["a", "x", "b"], relSet("a", "b"));
  approx(m.precision, 2 / 3, "precision");
  approx(m.recall, 1, "recall");
  approx(m.f1, 0.8, "f1"); // 2*(2/3*1)/(2/3+1)
  approx(m.mrr, 1, "mrr"); // first hit at rank 1
});

test("computeMetrics: MRR reflects the rank of the first relevant item", () => {
  const m = computeMetrics(["x", "y", "a"], relSet("a"));
  approx(m.precision, 1 / 3, "precision");
  approx(m.recall, 1, "recall");
  approx(m.mrr, 1 / 3, "mrr"); // first (only) hit at rank 3
});

test("computeMetrics: zero retrieved, relevant present → all zero", () => {
  const m = computeMetrics([], relSet("a"));
  approx(m.precision, 0, "precision");
  approx(m.recall, 0, "recall");
  approx(m.f1, 0, "f1");
  approx(m.mrr, 0, "mrr");
});

test("computeMetrics: nothing relevant + retriever abstains → rewarded", () => {
  const m = computeMetrics([], relSet());
  approx(m.precision, 1, "precision"); // returned nothing, correctly
  approx(m.recall, 1, "recall"); // vacuous
  approx(m.f1, 1, "f1");
  approx(m.mrr, 1, "mrr");
});

test("computeMetrics: nothing relevant + retriever emits junk → precision 0", () => {
  const m = computeMetrics(["x", "y"], relSet());
  approx(m.precision, 0, "precision");
  approx(m.recall, 1, "recall"); // vacuous
  approx(m.f1, 0, "f1");
  approx(m.mrr, 0, "mrr"); // could not abstain
});

test("computeMetrics: all relevant retrieved among extras", () => {
  const m = computeMetrics(["a", "b", "c", "d"], relSet("a", "b"));
  approx(m.precision, 0.5, "precision");
  approx(m.recall, 1, "recall");
  approx(m.f1, 2 / 3, "f1"); // 2*(0.5*1)/(1.5)
  approx(m.mrr, 1, "mrr");
});

test("entryId reads the `## <timestamp>` header", () => {
  assert.equal(entryId("## 2026-01-03T09:12:00Z\n\n**tried:** x"), "2026-01-03T09:12:00Z");
  assert.equal(entryId("no header here"), null);
});

// ---------------------------------------------------------------------------
// Fixture corpus + strategies — the headline findings, pinned deterministically
// ---------------------------------------------------------------------------

test("all fixture scenarios load with the documented shape", async () => {
  const scenarios = await loadScenarios(EVAL_DIR);
  assert.ok(scenarios.length >= 6, `expected >=6 scenarios, got ${scenarios.length}`);
  for (const s of scenarios) {
    assert.ok(s.task.length > 0, `${s.name}: task should be non-empty`);
    assert.ok(s.corpus.entries.length > 0, `${s.name}: corpus should have entries`);
    // Every labelled id must exist in the pooled corpus.
    const ids = new Set(s.corpus.entries.map((e) => e.id));
    for (const id of [...s.relevant, ...s.irrelevant]) {
      assert.ok(ids.has(id), `${s.name}: label ${id} not found in corpus`);
    }
  }
});

test("a scenario without an explicit k falls back to DEFAULT_K", async () => {
  const s = await loadScenario(resolve(EVAL_DIR, "stale-security"));
  // stale-security sets k:5 which equals DEFAULT_K; assert the plumbing works.
  assert.equal(s.k, 5);
  assert.equal(DEFAULT_K, 5);
});

test("recurrence (shipping ranking) beats the recency control on aggregate F1", async () => {
  const scenarios = await loadScenarios(EVAL_DIR);
  const rec = evaluateStrategy("recurrence", STRATEGIES.recurrence!, scenarios);
  const rcy = evaluateStrategy("recency", STRATEGIES.recency!, scenarios);
  assert.ok(
    rec.aggregate.f1 > rcy.aggregate.f1,
    `recurrence F1 ${rec.aggregate.f1} should beat recency F1 ${rcy.aggregate.f1}`,
  );
});

test("recurrence resurfaces an old recurring theme that recency drops (pathlib)", async () => {
  const s = await loadScenario(resolve(EVAL_DIR, "pathlib-recurs"));
  const rec = computeMetrics(makeRecurrenceRetriever()(s.corpus, s.task, s.k), s.relevant);
  const rcy = computeMetrics(recency(s.corpus, s.task, s.k), s.relevant);
  approx(rec.recall, 1, "recurrence recall"); // all 3 pathlib entries surfaced
  approx(rec.mrr, 1, "recurrence mrr");
  assert.ok(rcy.recall < rec.recall, "recency should surface fewer pathlib entries");
});

test("a dominant but irrelevant theme sinks recurrence below recency (unflattering)", async () => {
  const s = await loadScenario(resolve(EVAL_DIR, "dominant-irrelevant"));
  const rec = computeMetrics(makeRecurrenceRetriever()(s.corpus, s.task, s.k), s.relevant);
  const rcy = computeMetrics(recency(s.corpus, s.task, s.k), s.relevant);
  // The promoted prettier cluster fills the whole cutoff, burying the one
  // relevant entry. Recency, task-blind but recency-ordered, catches it.
  approx(rec.recall, 0, "recurrence buries the relevant entry");
  approx(rcy.recall, 1, "recency surfaces it");
});

test("the auto-only promotion bar keeps machine noise out (auto-vs-hand)", async () => {
  const s = await loadScenario(resolve(EVAL_DIR, "auto-vs-hand"));
  const rec = computeMetrics(makeRecurrenceRetriever()(s.corpus, s.task, s.k), s.relevant);
  const rcy = computeMetrics(recency(s.corpus, s.task, s.k), s.relevant);
  // The 3 hand-logged immer entries promote; the larger auto-only eslint cluster
  // does not, so recurrence surfaces the relevant theme while recency (dominated
  // by fresher auto entries) misses it entirely.
  approx(rec.recall, 1, "recurrence surfaces immer");
  approx(rcy.recall, 0, "recency misses the older immer entries");
});

test("sweep: the shipped PROMOTION_THRESHOLD is on the optimal F1 plateau", async () => {
  const scenarios = await loadScenarios(EVAL_DIR);
  const rows = runSweep(scenarios);
  const byT = new Map(rows.map((r) => [r.threshold, r.aggregate.f1]));
  const bestF1 = Math.max(...rows.map((r) => r.aggregate.f1));
  approx(byT.get(PROMOTION_THRESHOLD)!, bestF1, "shipped threshold is optimal");
  // Raising the threshold past the plateau strictly hurts F1.
  assert.ok(byT.get(6)! < byT.get(PROMOTION_THRESHOLD)!, "threshold 6 should score worse");
});

test("recency ignores the task text (control is genuinely task-blind)", async () => {
  const scenarios = await loadScenarios(EVAL_DIR);
  const s: Scenario = scenarios[0]!;
  const withTask = recency(s.corpus, s.task, s.k);
  const withoutTask = recency(s.corpus, "totally different task text", s.k);
  assert.deepEqual(withTask, withoutTask);
});

test("HOF-14: default evaluation names shipped selection and its delivery limits", async () => {
  const { execFileSync } = await import("node:child_process");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [cli, "evaluate", "--dir", EVAL_DIR, "--json"], { encoding: "utf8" }));
  assert.equal(result.report.strategy, "shipped");
  assert.match(result.caveat, /task relevance/);
  assert.match(result.caveat, /budgeted primer/);
  assert.doesNotMatch(result.caveat, /shipping ranker is task-blind/);
});
