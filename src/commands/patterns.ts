import { readOrEmpty, exists } from "../util/fs.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, join, resolve } from "node:path";
import { extractNgrams } from "../util/ngrams.js";

export interface PatternsOpts {
  /** Override default search roots. When set, HANDOFF_SEARCH_ROOTS env is ignored. */
  roots?: string[];
  /** Top-N for correction themes (default 20). Failure modes are capped at 10 regardless. */
  top?: number;
}

export interface ThemeEntry {
  ngram: string;
  projectCount: number;
  totalFreq: number;
  score: number;
  languages: string[];
}

export interface PatternsResult {
  projectCount: number;
  correctionThemes: ThemeEntry[];
  failureModes: ThemeEntry[];
  toolUsage: Record<string, number>;
}

const SKIP_DIRS = new Set<string>([
  "node_modules", ".git", ".cache", "dist", "build",
  ".venv", "venv", "__pycache__",
]);

const MAX_WALK_DEPTH = 5;

/**
 * Public entry point. Returns a structured result AND prints the report.
 * Called from cli.ts and also used by tests to verify structure.
 */
export async function patterns(opts: PatternsOpts = {}): Promise<PatternsResult> {
  const top = opts.top ?? 20;
  const roots = resolveRoots(opts.roots);

  const projects = await discoverHandoffProjects(roots);

  if (projects.length === 0) {
    console.log("No .handoff/ projects found.");
    return {
      projectCount: 0,
      correctionThemes: [],
      failureModes: [],
      toolUsage: {},
    };
  }

  // Per-project extraction
  const perProject = await Promise.all(
    projects.map(async (projectDir) => {
      const lang = await detectLanguage(projectDir);
      const tool = await readSourceTool(projectDir);
      const corrections = await readOrEmpty(join(projectDir, ".handoff", "corrections.md"));
      const attempts = await readOrEmpty(join(projectDir, ".handoff", "attempts.md"));
      return {
        dir: projectDir,
        language: lang,
        sourceTool: tool,
        correctionNgrams: extractNgrams(corrections),
        attemptNgrams: extractNgrams(attempts),
      };
    }),
  );

  const correctionThemes = aggregate(
    perProject.map((p) => ({ lang: p.language, ngrams: p.correctionNgrams })),
    top,
  );
  const failureModes = aggregate(
    perProject.map((p) => ({ lang: p.language, ngrams: p.attemptNgrams })),
    10,
  );
  const toolUsage = tallyTools(perProject.map((p) => p.sourceTool));

  printReport({
    projectCount: projects.length,
    correctionThemes,
    failureModes,
    toolUsage,
  });

  return {
    projectCount: projects.length,
    correctionThemes,
    failureModes,
    toolUsage,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function resolveRoots(override?: string[]): string[] {
  if (override && override.length > 0) {
    return override.map((r) => resolve(r));
  }
  const env = process.env.HANDOFF_SEARCH_ROOTS;
  if (env && env.trim()) {
    return env
      .split(pathDelimiter)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((r) => resolve(r));
  }
  const home = homedir();
  const defaults = [
    home,
    join(home, "Documents"),
    join(home, "code"),
    join(home, "Projects"),
    join(home, "src"),
    join(home, "repos"),
    join(home, "dev"),
    join(home, "workspace"),
  ];
  return defaults.map((r) => resolve(r));
}

/**
 * Inline walker. Walks each root up to MAX_WALK_DEPTH, skipping the usual
 * noise dirs. Any directory containing `.handoff/meta.json` qualifies as a
 * project. The parallel agent is building a shared util/discover.ts with
 * the same logic — this is deliberately kept simple and self-contained so
 * consolidation later is a mechanical replacement.
 */
async function discoverHandoffProjects(roots: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    await walk(root, 0, found);
  }
  return [...found].sort();
}

async function walk(dir: string, depth: number, found: Set<string>): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Is this dir itself a handoff project?
  const hasHandoffMeta = entries.some(
    (e) => e.isDirectory() && e.name === ".handoff",
  );
  if (hasHandoffMeta) {
    try {
      if (await exists(join(dir, ".handoff", "meta.json"))) found.add(dir);
    } catch {
      // .handoff/ exists but no meta.json — skip, it isn't a real project yet.
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".handoff") continue;
    if (entry.name === ".handoff") continue; // already handled above
    await walk(join(dir, entry.name), depth + 1, found);
  }
}

async function detectLanguage(projectDir: string): Promise<string> {
  const probes: Array<[string, string]> = [
    ["package.json", "node"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["Gemfile", "ruby"],
    ["composer.json", "php"],
  ];
  for (const [file, lang] of probes) {
    try {
      await fs.access(join(projectDir, file));
      return lang;
    } catch {
      // not found, try next
    }
  }
  return "unknown";
}

async function readSourceTool(projectDir: string): Promise<string> {
  try {
    const raw = await readOrEmpty(join(projectDir, ".handoff", "meta.json"));
    const meta = JSON.parse(raw) as { sourceTool?: unknown };
    if (typeof meta.sourceTool === "string" && meta.sourceTool) return meta.sourceTool;
  } catch {
    // fall through
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Tokenization / n-grams
// ---------------------------------------------------------------------------

/**
 * Return a map of ngram => count for a single markdown file.
 * Skips empty lines, heading lines (start with `#`), and list markers
 * (lines starting with `-`, `*`, `+`, or a numbered list like `1.`).
 */

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface ProjectNgrams {
  lang: string;
  ngrams: Map<string, number>;
}

function aggregate(perProject: ProjectNgrams[], topN: number): ThemeEntry[] {
  // ngram -> { projectCount, totalFreq, languages }
  const agg = new Map<
    string,
    { projectCount: number; totalFreq: number; languages: Set<string> }
  >();

  for (const p of perProject) {
    for (const [ngram, freq] of p.ngrams) {
      let entry = agg.get(ngram);
      if (!entry) {
        entry = { projectCount: 0, totalFreq: 0, languages: new Set() };
        agg.set(ngram, entry);
      }
      entry.projectCount += 1;
      entry.totalFreq += freq;
      entry.languages.add(p.lang);
    }
  }

  // Rank by projectCount × totalFreq. Tiebreak by projectCount desc, then
  // alpha asc for determinism.
  const ranked: ThemeEntry[] = [...agg.entries()]
    .map(([ngram, v]) => ({
      ngram,
      projectCount: v.projectCount,
      totalFreq: v.totalFreq,
      score: v.projectCount * v.totalFreq,
      languages: [...v.languages].sort(),
    }))
    // Only surface things that show up at least twice total. Single-shot
    // noise (one project says "foo" once) is not a meta-pattern.
    .filter((e) => e.totalFreq >= 2 || e.projectCount >= 2)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.projectCount !== a.projectCount) return b.projectCount - a.projectCount;
      return a.ngram.localeCompare(b.ngram);
    });

  return ranked.slice(0, topN);
}

function tallyTools(tools: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tools) {
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(r: PatternsResult): void {
  console.log(`Scanned ${r.projectCount} .handoff/ project${r.projectCount === 1 ? "" : "s"}.`);
  console.log();

  console.log("## Correction themes");
  if (r.correctionThemes.length === 0) {
    console.log("  (no recurring themes)");
  } else {
    printThemes(r.correctionThemes);
  }
  console.log();

  console.log("## Common failure modes");
  if (r.failureModes.length === 0) {
    console.log("  (no recurring failure modes)");
  } else {
    printThemes(r.failureModes);
  }
  console.log();

  console.log("## Initial source tool (projects, not usage events)");
  const toolEntries = Object.entries(r.toolUsage).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length === 0) {
    console.log("  (no tool data)");
  } else {
    const nameWidth = Math.max(...toolEntries.map(([k]) => k.length));
    for (const [name, count] of toolEntries) {
      console.log(`  ${name.padEnd(nameWidth)}  ${count} project${count === 1 ? "" : "s"}`);
    }
  }
}

function printThemes(themes: ThemeEntry[]): void {
  const ngramWidth = Math.max(...themes.map((t) => t.ngram.length));
  for (const t of themes) {
    const langTag = t.languages.length > 0 ? `[${t.languages.join(", ")}]` : "";
    console.log(
      `  ${t.ngram.padEnd(ngramWidth)}  projects=${t.projectCount}  hits=${t.totalFreq}  ${langTag}`,
    );
  }
}
