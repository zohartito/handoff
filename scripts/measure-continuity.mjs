// Reproduce the November 2026 baseline. Print counts only. Some read commands
// migrate meta.json, so even the status and primer checks run on scratch copies.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/handoff.mjs", import.meta.url));
const files = [
  ".capture-state.json", "HANDOFF.md", "attempts.md", "codebase-map.md",
  "corrections.md", "decisions.md", "environment.md", "files.json", "identity.md",
  "meta.json", "open-loops.md", "progress.md", "references.md", "task.md",
  "tool-history.jsonl", "transcript.jsonl", "handover-record.md", "ingested-context.md", "wiki.md",
];

function physicalLines(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function inventory(dir) {
  const result = {};
  for (const name of files) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    const lines = physicalLines(bytes.toString("utf8"));
    result[name] = { lines: lines.length, bytes: bytes.length };
    if (["attempts.md", "corrections.md", "decisions.md"].includes(name)) {
      result[name].records = lines.filter(line => /^## \d{4}-\d\d-\d\dT[\d:.]+Z\s*$/.test(line)).length;
    }
  }
  return result;
}

function run(cwd, args, input = "") {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: "utf8" });
  if (result.error) throw result.error;
  const dropped = Number(result.stderr.match(/(\d+) user constraint\(s\) were dropped/)?.[1] ?? 0);
  if (result.status !== 0 && !(args[0] === "prime" && result.status === 1 && dropped)) {
    throw new Error(`handoff ${args.join(" ")} failed (exit ${result.status}, signal ${result.signal})`);
  }
  return { stdout: result.stdout, exit: result.status, dropped };
}

// An optional physical JSONL line identifies an exact user quote for a local
// spot check. Only the line number and the boolean leave the replay.
async function inspectTranscript(path, primer, witnesses) {
  const facts = { bytes: statSync(path).size, lines: 0, compactions: 0, quoteInPrimer: {} };
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    facts.lines++;
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "system" && event.subtype === "compact_boundary") facts.compactions++;
    if (!witnesses.has(facts.lines)) continue;
    const content = event.message?.content;
    const quote = typeof content === "string" ? content : (content ?? [])
      .filter(part => part.type === "text").map(part => part.text).join("\n");
    if (event.type !== "user" || event.isMeta || event.isCompactSummary || !quote.trim()) {
      throw new Error(`Line ${facts.lines} is not a user quote`);
    }
    facts.quoteInPrimer[facts.lines] = primer.includes(quote.trim());
  }
  if (Object.keys(facts.quoteInPrimer).length !== witnesses.size) throw new Error("Missing witness line");
  return facts;
}

const [project, transcript, ...userLines] = process.argv.slice(2);
if (!project) throw new Error("Usage: node scripts/measure-continuity.mjs PROJECT [TRANSCRIPT.jsonl [USER_LINE ...]]");
const source = resolve(project, ".handoff");
if (!existsSync(source)) throw new Error("Project has no .handoff directory");
const scratch = mkdtempSync(join(tmpdir(), "handoff-baseline-"));
try {
  const snapshot = join(scratch, ".handoff");
  mkdirSync(snapshot);
  for (const name of files) {
    const path = join(source, name);
    if (existsSync(path)) copyFileSync(path, join(snapshot, name));
  }
  // A primer with evidence references needs files outside .handoff. This study
  // has permission to read only the session files, so reject that input.
  for (const name of ["corrections.md", "decisions.md"]) {
    const path = join(snapshot, name);
    if (existsSync(path) && /^\*\*evidence:\*\* /m.test(readFileSync(path, "utf8"))) {
      throw new Error("Cannot measure a project with external evidence from a .handoff-only copy");
    }
  }
  const inputFiles = inventory(snapshot);
  for (const [name, counts] of Object.entries(inputFiles)) {
    counts.sha256 = createHash("sha256").update(readFileSync(join(snapshot, name))).digest("hex");
  }
  const status = run(scratch, ["status"]);
  const prime = run(scratch, ["prime", "--compact"]);
  const result = {
    files: inputFiles,
    statusFilled: status.stdout.match(/^\s*● .*?\sfilled\s/gm)?.length ?? 0,
    compactDryRun: run(scratch, ["compact", "attempts", "--dry-run"]).stdout.trim(),
    primer: {
      lines: physicalLines(prime.stdout).length,
      bytes: Buffer.byteLength(prime.stdout),
      exit: prime.exit,
      droppedConstraints: prime.dropped,
    },
  };
  if (transcript) {
    const replay = join(scratch, "replay");
    mkdirSync(join(replay, ".handoff"), { recursive: true });
    run(replay, ["hook", "pre-compact"], JSON.stringify({
      cwd: replay, session_id: "baseline-replay", transcript_path: resolve(transcript),
    }));
    result.replay = inventory(join(replay, ".handoff"));
    const start = run(replay, ["hook", "session-start"], JSON.stringify({ source: "compact", cwd: replay }));
    const primer = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
    result.transcript = await inspectTranscript(transcript, primer, new Set(userLines.map(Number)));
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
