#!/usr/bin/env node
// Run only in a disposable repository. The checked-in baseline is an observed
// pre-repair run, never an imitation of the old behavior in current code.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "handoff.mjs");
const baselinePath = join(root, "docs", "first-run-before.json");
if (!existsSync(join(root, "dist", "cli.js"))) {
  throw new Error("Run npm run build before the walkthrough.");
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "handoff-first-run-")));
const repoName = "first-run-sample";
const repo = join(scratch, repoName);
const commitSubject = "docs: add walkthrough README";
mkdirSync(repo);
const isolatedHome = join(scratch, "home");
mkdirSync(isolatedHome);
// Ignore local git identity, signing, hooks, templates and environment overrides.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
Object.assign(env, {
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  XDG_CONFIG_HOME: isolatedHome,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(scratch, "empty-gitconfig"),
  GIT_AUTHOR_NAME: "Walkthrough",
  GIT_AUTHOR_EMAIL: "<email>",
  GIT_COMMITTER_NAME: "Walkthrough",
  GIT_COMMITTER_EMAIL: "<email>",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  NO_COLOR: "1",
});
writeFileSync(env.GIT_CONFIG_GLOBAL, "");

function sanitize(value) {
  let text = value;
  for (const [literal, replacement] of [
    [repo, `<tmp-dir>/${repoName}`], [scratch, "<tmp-dir>"],
    [root, "<repo>"], [homedir(), "<home>"], [hostname(), "<host>"],
  ]) {
    text = text.replaceAll(literal, replacement);
  }
  text = text.replaceAll(userInfo().username, "<user>");
  return text;
}

function primerMetrics(output) {
  const lines = output.trimEnd().split(/\r?\n/);
  // Count a line once even when it carries several facts. Generic instructions
  // mentioning .handoff/ or CLAUDE.md do not prove those files were observed.
  const factLines = lines.filter((line) => line.includes(repoName)
    || line.includes(commitSubject)
    || line.includes("README.md")
    || /^\?\? \.handoff\/$/.test(line));
  const blankLines = lines.filter((line) => !line.trim()).length;
  return {
    totalLines: lines.length,
    projectFactLines: factLines.length,
    boilerplateLines: lines.length - factLines.length - blankLines,
    blankLines,
    factLines,
  };
}

const steps = [];
function run(step, executable, args, command, primer = false) {
  const start = performance.now();
  const result = spawnSync(executable, args, {
    cwd: repo, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const entry = {
    step, command, seconds: Number(((performance.now() - start) / 1000).toFixed(3)),
    exitCode: result.status, signal: result.signal,
    stdout: sanitize(result.stdout ?? ""), stderr: sanitize(result.stderr ?? ""),
    error: result.error ? sanitize(result.error.message) : null,
    ...(primer && result.status === 0 ? { primer: primerMetrics(result.stdout) } : {}),
  };
  // Metrics are computed on raw output, then sanitized like every other receipt.
  if (entry.primer) entry.primer.factLines = entry.primer.factLines.map(sanitize);
  steps.push(entry);
  return entry;
}
function git(step, args) {
  const entry = run(step, "git", args, `git ${args.join(" ")}`);
  if (entry.exitCode !== 0) throw new Error(JSON.stringify(entry));
}
function handoff(step, args, primer = false) {
  return run(step, process.execPath, [cli, ...args], `handoff ${args.join(" ")}`, primer);
}

git("git-init", ["init", "--initial-branch=main", "--template="]);
const writeStart = performance.now();
writeFileSync(join(repo, "README.md"), `# ${repoName}\n\nA scratch repository for the first-run walkthrough.\n`);
steps.push({ step: "readme", command: "write README.md", seconds: Number(((performance.now() - writeStart) / 1000).toFixed(3)), exitCode: 0, stdout: "", stderr: "" });
git("git-add", ["add", "README.md"]);
git("git-commit", ["-c", "commit.gpgSign=false", "commit", "-m", commitSubject]);
const initialized = handoff("init", ["init"]);
handoff("status", ["status"]);
handoff("prime", ["prime", "--tool", "claude-code"], true);
handoff("positional-prime", ["prime", "claude-code"], true);
const hint = initialized.stdout.match(/when handing off: handoff (prime[^\n]*)/);
if (!hint) throw new Error("init did not print the expected next-step hint");
handoff("printed-hint", hint[1].replace("<target-tool>", "claude-code").trim().split(/\s+/), true);

const current = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  node: process.version,
  invocation: "node <repo>/bin/handoff.mjs (cwd: <tmp-dir>/first-run-sample)",
  steps,
  environment: sanitize(readFileSync(join(repo, ".handoff", "environment.md"), "utf8")),
};
const before = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
const reportPath = join(scratch, "first-run-walkthrough.json");
writeFileSync(reportPath, JSON.stringify({ before, after: current }, null, 2) + "\n");

function printTable(label, report) {
  console.log(`\n${label}`);
  console.log("step | command | seconds | exit | facts / boilerplate / blank");
  for (const entry of report.steps) {
    const metric = entry.primer;
    console.log(`${entry.step} | ${entry.command} | ${entry.seconds.toFixed(3)} | ${entry.exitCode ?? entry.signal ?? "error"} | ${metric ? `${metric.projectFactLines} / ${metric.boilerplateLines} / ${metric.blankLines}` : "—"}`);
  }
}
if (before) printTable("BEFORE (recorded baseline)", before);
printTable(before ? "AFTER (current build)" : "BASELINE (current build; no recorded baseline yet)", current);
if (before) {
  const prime = (report) => report.steps.find((entry) => entry.step === "prime").primer.projectFactLines;
  const hintExit = (report) => report.steps.find((entry) => entry.step === "printed-hint").exitCode;
  console.log(`\nproject-fact lines in primer: ${prime(before)} → ${prime(current)}`);
  console.log(`printed hint exit code: ${hintExit(before)} → ${hintExit(current)}`);
}
console.log(`\nJSON receipt: ${reportPath}`);
// The positional probe deliberately captures a known failure. Once a baseline
// exists, following the repaired hint must succeed too.
if (steps.some((entry) => entry.step !== "positional-prime"
  && (entry.step !== "printed-hint" || before) && entry.exitCode !== 0)) {
  process.exitCode = 1;
}
