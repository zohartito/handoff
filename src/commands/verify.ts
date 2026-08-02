import { readFile } from "node:fs/promises";
import { resolveHandoffPaths } from "../format/paths.js";
import { exists, readOrEmpty } from "../util/fs.js";
import { extractNgrams } from "../util/ngrams.js";
import { rankEntries, entryTextForRanking } from "./ranking.js";

/**
 * `handoff verify` — did the handoff actually land?
 *
 * Until now nothing closed the loop: you paste a primer into the next tool and
 * hope. If the receiving agent re-asks something already decided, you find out
 * by being annoyed, not by a signal.
 *
 * Two steps, because we deliberately do not call an LLM (zero runtime deps,
 * no API key, works offline):
 *   1. `handoff verify` prints a restatement prompt for the receiving agent.
 *   2. `handoff verify --check <file|--stdin>` scores the agent's answer against
 *      what `.handoff/` actually says, and names what it missed.
 *
 * Scoring is deliberately lexical, not semantic. It cannot tell you the answer
 * was *right* — only whether the load-bearing facts were carried across at all.
 * A missed fact is a strong signal; a matched fact is weak evidence. The output
 * says so rather than implying a grade.
 */

export type VerifyOpts = {
  check?: boolean;
  file?: string;
  stdin?: NodeJS.ReadableStream;
  cwd?: string;
};

/** Fraction of a fact's distinctive terms the restatement must contain to count. */
const TERM_HIT_RATIO = 0.34;
/** Facts below this coverage make the handoff suspect. */
const PASS_RATIO = 0.6;

export const RESTATEMENT_PROMPT = `Before doing any work, restate — from the handoff context you were given, without re-reading the project:

1. THE TASK — what is the goal, in one sentence?
2. CONSTRAINTS — the top 3 things you must NOT do (rules, corrections, standing constraints).
3. PRIOR FAILURES — what has already been tried and did not work?
4. OPEN LOOPS — what is unfinished right now?

Write the answer to a file, then run:
    handoff verify --check <that-file>

If you cannot answer a section from the handoff alone, write "UNKNOWN" for it —
that is the useful signal, not a failure.`;

type Fact = {
  kind: "task" | "constraint" | "failure" | "open-loop";
  /** Human-readable label shown when the fact is missing. */
  label: string;
  /** Distinctive terms; the restatement must hit TERM_HIT_RATIO of them. */
  terms: string[];
};

/** Distinctive terms for one piece of source text, most-distinctive first. */
export function keyTerms(text: string, limit = 8): string[] {
  // includeListLines is essential on both sides of the comparison: open loops
  // are bullets, and the restatement prompt explicitly asks for a numbered
  // list. Dropping list lines discarded the entire content of a correctly
  // formatted answer, scoring a perfect restatement as zero.
  const counts = extractNgrams(entryTextForRanking(text), { includeListLines: true });
  // Prefer bigrams (more specific), then by frequency, then alphabetical for
  // determinism.
  return [...counts.entries()]
    .sort((a, b) => {
      const aBi = a[0].includes(" ") ? 1 : 0;
      const bBi = b[0].includes(" ") ? 1 : 0;
      return bBi - aBi || b[1] - a[1] || a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([term]) => term);
}

/**
 * True when the restatement contains enough of the fact's distinctive terms.
 *
 * The ratio alone is too generous on short term lists — a fact with two terms
 * would count as carried across on a single incidental word, so filler like
 * "happy to help, what should I work on?" scored partial credit. Require at
 * least two distinct hits whenever the fact has enough terms to demand it.
 */
export function factCovered(fact: Fact, restatement: string): boolean {
  if (fact.terms.length === 0) return true;
  // Tokenize the restatement exactly as the terms were produced, so matching is
  // on whole words and bigrams. Plain substring matching let a term hit inside
  // an unrelated longer word, which handed partial credit to pure filler.
  const hay = new Set(
    extractNgrams(restatement, { includeListLines: true }).keys(),
  );
  const hits = fact.terms.filter((t) => hay.has(t)).length;
  const needed = Math.min(
    fact.terms.length,
    Math.max(2, Math.ceil(fact.terms.length * TERM_HIT_RATIO)),
  );
  return hits >= needed;
}

/** Build the fact list the restatement is scored against. */
export async function collectFacts(paths: ReturnType<typeof resolveHandoffPaths>): Promise<Fact[]> {
  const facts: Fact[] = [];

  const task = (await readOrEmpty(paths.task)).trim();
  if (task) {
    facts.push({ kind: "task", label: "the task/goal", terms: keyTerms(task, 10) });
  }

  // Standing rules are the constraints that matter most; fall back to the most
  // recent corrections when nothing has recurred often enough to promote.
  const corrections = await readOrEmpty(paths.corrections);
  const rankedCorrections = rankEntries(corrections, { recentN: 3, maxStanding: 3 });
  for (const rule of rankedCorrections.standing) {
    facts.push({
      kind: "constraint",
      label: `standing rule: "${truncate(rule.line, 60)}"`,
      terms: keyTerms(rule.line, 6),
    });
  }
  if (rankedCorrections.standing.length === 0) {
    for (const entry of rankedCorrections.recent) {
      facts.push({
        kind: "constraint",
        label: `correction: "${truncate(firstValue(entry), 60)}"`,
        terms: keyTerms(entry, 6),
      });
    }
  }

  const attempts = await readOrEmpty(paths.attempts);
  for (const entry of rankEntries(attempts, { recentN: 2, maxStanding: 2 }).recent) {
    facts.push({
      kind: "failure",
      label: `failed attempt: "${truncate(firstValue(entry), 60)}"`,
      terms: keyTerms(entry, 6),
    });
  }

  const openLoops = (await readOrEmpty(paths.openLoops)).trim();
  const loopLines = openLoops
    .split("\n")
    // Only top-level bullets: an indented sub-bullet is a detail of the loop
    // above it, not a loop of its own.
    .filter((l) => /^[-*]\s/.test(l))
    // A checked box is finished work. Counting it as open inflates the
    // denominator and asks the agent to restate something already done.
    .filter((l) => !/^[-*]\s*\[[xX]\]/.test(l.trim()))
    .map((l) => l.trim().replace(/^[-*]\s+/, "").replace(/^\[\s*\]\s*/, ""))
    .filter((l) => l.length > 12)
    .slice(0, 3);
  for (const text of loopLines) {
    facts.push({
      kind: "open-loop",
      label: `open loop: "${truncate(text, 60)}"`,
      terms: keyTerms(text, 6),
    });
  }

  // A fact with no distinctive terms can never be judged, and counting it as
  // covered silently inflates the score. Drop it instead.
  return facts.filter((f) => f.terms.length > 0);
}

export async function verify(opts: VerifyOpts = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not found. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  if (!opts.check) {
    console.log(RESTATEMENT_PROMPT);
    return;
  }

  // Reading stdin from an interactive terminal waits for EOF forever with no
  // prompt — the user just sees a hang. Fail fast and say what to do instead.
  if (!opts.file && !opts.stdin && process.stdin.isTTY) {
    console.error(
      "verify: --check needs a restatement. pass `--file <path>`, or pipe one in:\n" +
        "  cat answer.md | handoff verify --check --stdin",
    );
    process.exitCode = 1;
    return;
  }

  let restatement: string;
  try {
    restatement = opts.file
      ? await readFile(opts.file, "utf8")
      : await readStream(opts.stdin ?? process.stdin);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === "ENOENT"
        ? `verify: file not found: ${opts.file}`
        : err instanceof Error
          ? err.message
          : String(err),
    );
    process.exitCode = 1;
    return;
  }

  if (!restatement.trim()) {
    console.error("verify: restatement is empty — nothing to check.");
    process.exitCode = 1;
    return;
  }

  const facts = await collectFacts(paths);
  if (facts.length === 0) {
    console.log("nothing to verify against — `.handoff/` has no task, corrections or open loops yet.");
    return;
  }

  const missed = facts.filter((f) => !factCovered(f, restatement));
  const covered = facts.length - missed.length;
  const ratio = covered / facts.length;

  console.log(`# handoff verify\n`);
  console.log(`carried across: ${covered}/${facts.length} facts\n`);

  if (missed.length > 0) {
    console.log("not reflected in the restatement:");
    for (const m of missed) console.log(`  ✗ ${m.label}`);
    console.log();
  }

  if (missed.length === 0) {
    console.log("every fact was mentioned somewhere in the restatement.");
  } else if (ratio >= PASS_RATIO) {
    console.log("most facts were mentioned. the misses above are worth a look.");
  } else {
    console.log(
      "little of `.handoff/` came through. worth re-priming (`handoff prime`)\n" +
        "before the agent starts work — but read the misses first, see the caveat.",
    );
  }

  // The honest caveat, printed every time.
  //
  // This is word-overlap matching, and it was tested adversarially: a
  // restatement that CONTRADICTS the source scores the same as one that agrees
  // (negation is invisible), keyword-stuffed nonsense can score full marks, and
  // a correct answer written in synonyms can score zero. So the number is a
  // prompt to go look, not a grade — and deliberately NOT an exit code. Gating
  // anything on it would encode a signal that does not hold.
  console.log(
    "\nthis is word-overlap matching, not comprehension: it cannot see whether a\n" +
      "restatement contradicts the source, and a correct answer in different words\n" +
      "will under-score. treat the misses as a checklist, not a verdict.",
  );
}

function firstValue(entry: string): string {
  const m = entry.match(/^\*\*[a-z ]+:\*\*\s*(.+)$/im);
  return m?.[1]?.trim() ?? entry.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}
