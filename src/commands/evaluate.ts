import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { exists, readOrEmpty } from "../util/fs.js";
import {
  rankEntries,
  splitEntries,
  entryId,
  PROMOTION_THRESHOLD,
} from "./ranking.js";
import { retrieveForTask } from "./retrieval.js";

/**
 * `handoff evaluate` — a deterministic RETRIEVAL eval for the ranking.
 *
 * The ranker (commands/ranking.ts) decides which corrections/attempts a
 * receiving agent sees. Its thresholds (PROMOTION_THRESHOLD, etc.) were picked
 * by reasoning, never measured. This harness makes them decidable.
 *
 * It deliberately does NOT run an LLM. Instead it asks one deterministic
 * question per scenario: given a task and a corpus of corrections/attempts,
 * does the retriever surface the entries a human labelled RELEVANT to that
 * task? That is free, fast, offline, and reproducible.
 *
 * What it measures: retrieval quality — did the right entries reach the top of
 * the list. What it does NOT measure: end-to-end agent behaviour, whether the
 * agent read the primer, comprehension, or outcomes. The shipping ranker is
 * also task-blind (it ranks by recurrence and recency, never reading the task
 * text), so these scores compare fixed orderings against per-task human labels.
 * The output says so on every run.
 */

/** Default retrieval cutoff when a scenario does not set its own `k`. */
export const DEFAULT_K = 5;

/** Thresholds swept by `--sweep`, bracketing the shipped PROMOTION_THRESHOLD. */
export const SWEEP_THRESHOLDS = [2, 3, 4, 5, 6] as const;

export const EVAL_CAVEAT =
  "This is a retrieval eval: it measures whether the ranker surfaces the entries\n" +
  "a human labelled relevant to each task. It does NOT measure agent behaviour,\n" +
  "comprehension, or outcomes, and the shipping ranker is task-blind (it ranks by\n" +
  "recurrence and recency, never reading the task). Treat the scores as a\n" +
  "comparison between ranking strategies on this corpus, not an absolute grade.";

/** One entry of a pooled corpus (corrections + attempts). */
export interface EvalEntry {
  /** The `## <timestamp>` header text — the stable id used by labels. */
  id: string;
  /** Full entry text, header included. */
  text: string;
  source: "corrections" | "attempts";
  /** Parsed from the ISO id; NaN when the header is not a date. */
  timestamp: number;
  /** Stable position across the pooled corpus (corrections then attempts). */
  order: number;
}

export interface Corpus {
  /** Pooled entries in original order. */
  entries: EvalEntry[];
  /** Raw `corrections.md`, so a retriever can call the real ranker on it. */
  corrections: string;
  /** Raw `attempts.md`. */
  attempts: string;
}

export interface Scenario {
  name: string;
  task: string;
  corpus: Corpus;
  relevant: Set<string>;
  irrelevant: Set<string>;
  k: number;
}

/** A retrieval strategy: return entry ids, best first, at most `k`. */
export type Retriever = (corpus: Corpus, task: string, k: number) => string[];

export interface Metrics {
  precision: number;
  recall: number;
  f1: number;
  mrr: number;
}

/**
 * Score a ranked, top-k id list against a relevant set.
 *
 * Conventions for the empty edges, chosen so the "nothing is relevant" scenario
 * rewards abstention rather than silently passing everyone:
 * - relevant empty  → recall = 1 (vacuous); precision = 1 iff nothing returned;
 *   mrr = 1 iff nothing returned, else 0.
 * - retrieved empty, relevant non-empty → all zero.
 */
export function computeMetrics(retrieved: string[], relevant: ReadonlySet<string>): Metrics {
  const hits = retrieved.filter((id) => relevant.has(id)).length;

  const precision =
    retrieved.length === 0 ? (relevant.size === 0 ? 1 : 0) : hits / retrieved.length;
  const recall = relevant.size === 0 ? 1 : hits / relevant.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  let mrr: number;
  if (relevant.size === 0) {
    mrr = retrieved.length === 0 ? 1 : 0;
  } else {
    const idx = retrieved.findIndex((id) => relevant.has(id));
    mrr = idx === -1 ? 0 : 1 / (idx + 1);
  }

  return { precision, recall, f1, mrr };
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Control strategy: plain last-N by recency, task-ignored. If the recurrence
 * ranker cannot beat this, the promotion machinery is not earning its keep —
 * which is a finding, not something to hide.
 */
export const recency: Retriever = (corpus, _task, k) => {
  return [...corpus.entries]
    .sort((a, b) => {
      const ta = Number.isNaN(a.timestamp) ? -Infinity : a.timestamp;
      const tb = Number.isNaN(b.timestamp) ? -Infinity : b.timestamp;
      return tb - ta || b.order - a.order;
    })
    .slice(0, k)
    .map((e) => e.id);
};

/**
 * The SHIPPING behaviour, as a retriever. It calls the real `rankEntries` — the
 * baseline must be the production code, not a reimplementation. Ordering mirrors
 * the primer: promoted standing rules first (strongest theme first, newest
 * cluster member first), then the recent tails, newest first.
 */
export function makeRecurrenceRetriever(threshold: number = PROMOTION_THRESHOLD): Retriever {
  return (corpus, _task, k) => {
    const big = Math.max(corpus.entries.length, 1);
    const ranked = [corpus.corrections, corpus.attempts].map((raw) =>
      rankEntries(raw, {
        recentN: big,
        maxStanding: big,
        promotionThreshold: threshold,
        withIds: true,
      }),
    );

    const ids: string[] = [];
    for (const r of ranked) {
      for (const group of r.standingIds ?? []) {
        for (const id of [...group].reverse()) ids.push(id);
      }
    }
    for (const r of ranked) {
      for (const entry of [...r.recent].reverse()) {
        const id = entryId(entry);
        if (id) ids.push(id);
      }
    }

    return dedupe(ids).slice(0, k);
  };
}

/** Registered strategies, comparable side by side. */
/**
 * Task-aware retrieval: score entries by overlap with the task, with a
 * recurrence bonus. `weight` 0 is pure relevance.
 */
export function makeRelevanceRetriever(weight?: number): Retriever {
  return (corpus, task, k) =>
    retrieveForTask(
      corpus.entries.map((e) => ({ id: e.id, text: e.text })),
      task,
      weight === undefined ? {} : { recurrenceWeight: weight },
    )
      .slice(0, k)
      .map((e) => e.id);
}

/** Registered strategies, comparable side by side. */
export const STRATEGIES: Record<string, Retriever> = {
  recurrence: makeRecurrenceRetriever(),
  recency,
  relevance: makeRelevanceRetriever(0),
  hybrid: makeRelevanceRetriever(),
};

interface RawLabels {
  description?: string;
  relevant?: string[];
  irrelevant?: string[];
  k?: number;
}

export async function loadScenario(dir: string): Promise<Scenario> {
  const correctionsRaw = await readOrEmpty(join(dir, "corrections.md"));
  const attemptsRaw = await readOrEmpty(join(dir, "attempts.md"));
  const task = (await readOrEmpty(join(dir, "task.md"))).trim();
  const labels = JSON.parse(await readFile(join(dir, "labels.json"), "utf8")) as RawLabels;

  const entries: EvalEntry[] = [];
  let order = 0;
  for (const [source, raw] of [
    ["corrections", correctionsRaw],
    ["attempts", attemptsRaw],
  ] as const) {
    for (const text of splitEntries(raw)) {
      const id = entryId(text) ?? `${source}#${order}`;
      entries.push({ id, text, source, timestamp: Date.parse(id), order: order++ });
    }
  }

  return {
    name: basename(dir),
    task,
    corpus: { entries, corrections: correctionsRaw, attempts: attemptsRaw },
    relevant: new Set(labels.relevant ?? []),
    irrelevant: new Set(labels.irrelevant ?? []),
    k: typeof labels.k === "number" ? labels.k : DEFAULT_K,
  };
}

export async function loadScenarios(rootDir: string): Promise<Scenario[]> {
  let dirents;
  try {
    dirents = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = dirents
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const scenarios: Scenario[] = [];
  for (const name of names) {
    const dir = join(rootDir, name);
    if (await exists(join(dir, "labels.json"))) scenarios.push(await loadScenario(dir));
  }
  return scenarios;
}

export interface ScenarioResult {
  scenario: string;
  k: number;
  retrieved: string[];
  metrics: Metrics;
}

export interface StrategyReport {
  strategy: string;
  perScenario: ScenarioResult[];
  aggregate: Metrics;
}

function macroAverage(metrics: Metrics[]): Metrics {
  if (metrics.length === 0) return { precision: 0, recall: 0, f1: 0, mrr: 0 };
  const acc = metrics.reduce(
    (a, m) => ({
      precision: a.precision + m.precision,
      recall: a.recall + m.recall,
      f1: a.f1 + m.f1,
      mrr: a.mrr + m.mrr,
    }),
    { precision: 0, recall: 0, f1: 0, mrr: 0 },
  );
  const n = metrics.length;
  return { precision: acc.precision / n, recall: acc.recall / n, f1: acc.f1 / n, mrr: acc.mrr / n };
}

export function evaluateStrategy(
  strategy: string,
  retriever: Retriever,
  scenarios: Scenario[],
  kOverride?: number,
): StrategyReport {
  const perScenario = scenarios.map((s) => {
    const k = kOverride ?? s.k;
    const retrieved = retriever(s.corpus, s.task, k);
    return { scenario: s.name, k, retrieved, metrics: computeMetrics(retrieved, s.relevant) };
  });
  return { strategy, perScenario, aggregate: macroAverage(perScenario.map((r) => r.metrics)) };
}

export interface SweepRow {
  threshold: number;
  aggregate: Metrics;
}

export function runSweep(
  scenarios: Scenario[],
  thresholds: readonly number[] = SWEEP_THRESHOLDS,
  kOverride?: number,
): SweepRow[] {
  return thresholds.map((threshold) => ({
    threshold,
    aggregate: evaluateStrategy(
      `recurrence@${threshold}`,
      makeRecurrenceRetriever(threshold),
      scenarios,
      kOverride,
    ).aggregate,
  }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface EvaluateOpts {
  strategy?: string;
  compare?: boolean;
  json?: boolean;
  sweep?: boolean;
  k?: number;
  dir?: string;
  cwd?: string;
}

const METRIC_KEYS: Array<keyof Metrics> = ["precision", "recall", "f1", "mrr"];

function fmt(n: number): string {
  return n.toFixed(3);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

export async function evaluate(opts: EvaluateOpts = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const rootDir = opts.dir ? resolve(cwd, opts.dir) : resolve(cwd, "tests/fixtures/eval");

  const scenarios = await loadScenarios(rootDir);
  if (scenarios.length === 0) {
    console.error(
      `evaluate: no scenarios found in ${rootDir}\n` +
        "(run from the repo root, or pass --dir <path to eval fixtures>)",
    );
    process.exitCode = 1;
    return;
  }

  if (opts.strategy && !opts.compare && !opts.sweep && !STRATEGIES[opts.strategy]) {
    console.error(
      `evaluate: unknown strategy "${opts.strategy}" (known: ${Object.keys(STRATEGIES).join(", ")})`,
    );
    process.exitCode = 1;
    return;
  }

  if (opts.sweep) {
    const rows = runSweep(scenarios, SWEEP_THRESHOLDS, opts.k);
    if (opts.json) {
      console.log(
        JSON.stringify(
          { mode: "sweep", shippedThreshold: PROMOTION_THRESHOLD, scenarios: scenarios.length, rows, caveat: EVAL_CAVEAT },
          null,
          2,
        ),
      );
      return;
    }
    renderSweep(rows, scenarios.length);
    return;
  }

  if (opts.compare) {
    const reports = Object.entries(STRATEGIES).map(([name, r]) =>
      evaluateStrategy(name, r, scenarios, opts.k),
    );
    if (opts.json) {
      console.log(JSON.stringify({ mode: "compare", reports, caveat: EVAL_CAVEAT }, null, 2));
      return;
    }
    renderCompare(reports, scenarios.length);
    return;
  }

  const strategy = opts.strategy ?? "recurrence";
  const report = evaluateStrategy(strategy, STRATEGIES[strategy]!, scenarios, opts.k);
  if (opts.json) {
    console.log(JSON.stringify({ mode: "single", report, caveat: EVAL_CAVEAT }, null, 2));
    return;
  }
  renderReport(report);
}

function renderReport(report: StrategyReport): void {
  const nameW = Math.max(8, ...report.perScenario.map((r) => r.scenario.length));
  console.log(`# handoff evaluate — strategy: ${report.strategy}\n`);
  console.log(
    `${pad("scenario", nameW)}  ${padLeft("k", 3)}  ${padLeft("prec", 6)}  ${padLeft("rec", 6)}  ${padLeft("f1", 6)}  ${padLeft("mrr", 6)}`,
  );
  console.log("-".repeat(nameW + 2 + 3 + (2 + 6) * 4));
  for (const r of report.perScenario) {
    console.log(
      `${pad(r.scenario, nameW)}  ${padLeft(String(r.k), 3)}  ${padLeft(fmt(r.metrics.precision), 6)}  ${padLeft(fmt(r.metrics.recall), 6)}  ${padLeft(fmt(r.metrics.f1), 6)}  ${padLeft(fmt(r.metrics.mrr), 6)}`,
    );
  }
  console.log("-".repeat(nameW + 2 + 3 + (2 + 6) * 4));
  const a = report.aggregate;
  console.log(
    `${pad("MACRO AVG", nameW)}  ${padLeft("", 3)}  ${padLeft(fmt(a.precision), 6)}  ${padLeft(fmt(a.recall), 6)}  ${padLeft(fmt(a.f1), 6)}  ${padLeft(fmt(a.mrr), 6)}`,
  );
  console.log(`\n${EVAL_CAVEAT}`);
}

function renderCompare(reports: StrategyReport[], scenarioCount: number): void {
  console.log(`# handoff evaluate --compare  (${scenarioCount} scenarios, macro-averaged)\n`);

  const stratW = Math.max(10, ...reports.map((r) => r.strategy.length));
  console.log(
    `${pad("strategy", stratW)}  ${padLeft("prec", 6)}  ${padLeft("rec", 6)}  ${padLeft("f1", 6)}  ${padLeft("mrr", 6)}`,
  );
  console.log("-".repeat(stratW + (2 + 6) * 4));

  const winners: Record<string, string> = {};
  for (const key of METRIC_KEYS) {
    let best = reports[0]!;
    for (const r of reports) if (r.aggregate[key] > best.aggregate[key]) best = r;
    winners[key] = best.strategy;
  }

  for (const r of reports) {
    const mark = (key: keyof Metrics) => (winners[key] === r.strategy ? "*" : " ");
    console.log(
      `${pad(r.strategy, stratW)}  ${padLeft(fmt(r.aggregate.precision), 6)}${mark("precision")} ${padLeft(fmt(r.aggregate.recall), 6)}${mark("recall")} ${padLeft(fmt(r.aggregate.f1), 6)}${mark("f1")} ${padLeft(fmt(r.aggregate.mrr), 6)}${mark("mrr")}`,
    );
  }
  console.log("\n* = best on that metric.");
  console.log(`\n${EVAL_CAVEAT}`);
}

function renderSweep(rows: SweepRow[], scenarioCount: number): void {
  console.log(
    `# handoff evaluate --sweep  (recurrence PROMOTION_THRESHOLD, ${scenarioCount} scenarios, macro-averaged)\n`,
  );
  console.log(
    `${padLeft("thresh", 6)}  ${padLeft("prec", 6)}  ${padLeft("rec", 6)}  ${padLeft("f1", 6)}  ${padLeft("mrr", 6)}`,
  );
  console.log("-".repeat(6 + (2 + 6) * 4));

  const EPS = 1e-9;
  const bestF1 = Math.max(...rows.map((r) => r.aggregate.f1));
  const optimal = rows.filter((r) => bestF1 - r.aggregate.f1 <= EPS).map((r) => r.threshold);

  for (const row of rows) {
    const shipped = row.threshold === PROMOTION_THRESHOLD ? " (shipped)" : "";
    const best = bestF1 - row.aggregate.f1 <= EPS ? " <- best F1" : "";
    console.log(
      `${padLeft(String(row.threshold), 6)}  ${padLeft(fmt(row.aggregate.precision), 6)}  ${padLeft(fmt(row.aggregate.recall), 6)}  ${padLeft(fmt(row.aggregate.f1), 6)}  ${padLeft(fmt(row.aggregate.mrr), 6)}${shipped}${best}`,
    );
  }
  const shippedIsOptimal = optimal.includes(PROMOTION_THRESHOLD);
  console.log(
    `\nshipped PROMOTION_THRESHOLD = ${PROMOTION_THRESHOLD}; best F1 at threshold${optimal.length > 1 ? "s" : ""} ${optimal.join(", ")}` +
      (shippedIsOptimal
        ? ` — the shipped value is optimal on this corpus.`
        : ` — the shipped value is NOT optimal on this corpus.`),
  );
  console.log(`\n${EVAL_CAVEAT}`);
}
