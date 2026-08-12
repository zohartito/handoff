#!/usr/bin/env node
// SCHED loop (nightly): retrieval-eval regression run for handoff.
//
// Re-runs the two eval suites that guard retrieval quality — tests/retrieval.test.ts
// (relevance ranking / IDF / recurrence) and tests/evaluate.test.ts (precision /
// recall / F1 metrics + strategy sweep) — as a nightly regression, so a ranking
// or metric drift is caught even when nobody opened a PR. It reuses the existing
// build (`tsc -p tsconfig.test.json` -> dist-test/) and `node --test`; it does NOT
// duplicate the suites.
//
// Deterministic, no LLM, no network. Emits one `loop-result/v1` JSON object to
// stdout; exit code is the gate (0 = green, 1 = regression / build fail).
//
//   node scripts/retrieval-eval.mjs             # local: run + append LEARNINGS
//   node scripts/retrieval-eval.mjs --ci        # CI: JSON only, no LEARNINGS append
//   node scripts/retrieval-eval.mjs --dry-run   # prove wiring, never fail
//   node scripts/retrieval-eval.mjs --no-build  # run existing dist-test as-is

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const LEARNINGS = join(REPO_ROOT, ".claude", "LEARNINGS.md");
const TSC = join(REPO_ROOT, "node_modules", ".bin", "tsc");

const LOOP_ID = "retrieval-eval";
const BUILD_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;

// The eval suites this loop guards (compiled paths under dist-test/).
const EVAL_TESTS = [
  "dist-test/tests/retrieval.test.js",
  "dist-test/tests/evaluate.test.js",
];

const args = new Set(process.argv.slice(2));
const isCi = args.has("--ci");
const isDryRun = args.has("--dry-run");
const noBuild = args.has("--no-build");

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function finish(result, exitCode) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!isCi && !isDryRun) {
    mkdirSync(dirname(LEARNINGS), { recursive: true });
    appendFileSync(LEARNINGS, result.learning + "\n", "utf8");
  }
  process.exit(isDryRun ? 0 : exitCode);
}

function makeResult({ passed, verdict, summary, metrics }) {
  const ts = utcNow();
  return {
    schema: "loop-result/v1",
    repo: "handoff",
    loop: LOOP_ID,
    kind: "sched-nightly",
    timestamp: ts,
    passed,
    summary,
    metrics,
    learning: `${ts} [${LOOP_ID}] ${verdict} — ${summary}`,
  };
}

// Parse node --test TAP summary lines (`# pass 31`, `# fail 0`, ...).
function parseTap(output) {
  const counts = {};
  for (const key of ["tests", "pass", "fail", "skipped", "todo"]) {
    const m = output.match(new RegExp(`^# ${key} (\\d+)`, "m"));
    if (m) counts[key] = Number(m[1]);
  }
  return counts;
}

function main() {
  let buildOk = true;
  if (!noBuild) {
    const build = spawnSync(TSC, ["-p", "tsconfig.test.json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MS,
    });
    buildOk = build.status === 0;
  }

  const missing = EVAL_TESTS.filter((f) => !existsSync(join(REPO_ROOT, f)));
  if (missing.length) {
    finish(
      makeResult({
        passed: false,
        verdict: "FAIL",
        summary: `compiled eval suites missing: ${missing.join(", ")} (build_ok=${buildOk})`,
        metrics: { build_ok: buildOk, files: EVAL_TESTS, counts: {} },
      }),
      1,
    );
    return;
  }

  const run = spawnSync("node", ["--test", ...EVAL_TESTS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
  });
  const counts = parseTap((run.stdout || "") + (run.stderr || ""));
  const testsPassed = run.status === 0;
  const passed = buildOk && testsPassed;

  let verdict;
  let summary;
  if (!buildOk) {
    verdict = "FAIL";
    summary = "test build (tsc -p tsconfig.test.json) failed";
  } else if (testsPassed) {
    verdict = "PASS";
    summary = `retrieval+evaluate green: ${counts.pass ?? "?"}/${counts.tests ?? "?"} passed`;
  } else {
    verdict = "FAIL";
    summary = `REGRESSION: ${counts.fail ?? "?"} failing in retrieval/evaluate suites`;
  }

  finish(
    makeResult({
      passed,
      verdict,
      summary,
      metrics: { build_ok: buildOk, files: EVAL_TESTS, counts },
    }),
    passed ? 0 : 1,
  );
}

main();
