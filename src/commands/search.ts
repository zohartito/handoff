import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  discoverHandoffProjects,
  type HandoffProject,
} from "../util/discover.js";

export interface SearchOpts {
  roots?: string[];
  limit?: number;
  caseSensitive?: boolean;
}

export interface SearchMatch {
  projectPath: string;
  relativeFile: string;
  lineNumber: number;
  line: string;
  updatedAt: Date | null;
  exactWord: boolean;
}

const FILES_TO_SCAN = [
  "task.md",
  "progress.md",
  "decisions.md",
  "corrections.md",
  "attempts.md",
  "HANDOFF.md",
];

const MAX_LINE_LEN = 140;

/**
 * Escape a string so it can be embedded in a RegExp as a literal.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(s: string, n: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= n) return trimmed;
  return trimmed.slice(0, n - 1) + "\u2026";
}

/**
 * Scan a single file for matches of `needleLower` (already lowercased
 * if the caller wants case-insensitive behaviour). Returns one match
 * per matching line, in line order.
 */
async function scanFile(
  project: HandoffProject,
  filePath: string,
  relativeFile: string,
  query: string,
  caseSensitive: boolean,
  wordBoundary: RegExp,
): Promise<SearchMatch[]> {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const haystackTransform = caseSensitive ? (s: string) => s : (s: string) => s.toLowerCase();
  const needle = haystackTransform(query);

  const out: SearchMatch[] = [];
  const lines = contents.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const hay = haystackTransform(line);
    if (!hay.includes(needle)) continue;
    const exactWord = wordBoundary.test(line);
    // wordBoundary is a /g regex; reset between lines so the next test
    // doesn't pick up a stale lastIndex.
    wordBoundary.lastIndex = 0;
    out.push({
      projectPath: project.projectPath,
      relativeFile,
      lineNumber: i + 1,
      line: truncate(line, MAX_LINE_LEN),
      updatedAt: project.updatedAt,
      exactWord,
    });
  }
  return out;
}

/**
 * Library-level search: returns a ranked list of matches across all
 * discovered .handoff/ projects. Ranking:
 *   1. exact-word matches first
 *   2. most recently updated project first (null-updatedAt last)
 *   3. line order within a file
 * The `limit` is applied AFTER ranking.
 */
export async function searchProjects(
  query: string,
  opts: SearchOpts = {},
): Promise<{ matches: SearchMatch[]; projectsScanned: number }> {
  const caseSensitive = opts.caseSensitive ?? false;
  const limit = opts.limit ?? 20;

  const projects = await discoverHandoffProjects({ roots: opts.roots });
  if (projects.length === 0 || query.length === 0) {
    return { matches: [], projectsScanned: projects.length };
  }

  // Exact-word match: the query is not immediately adjacent to a
  // word character OR a hyphen. Treating `-` as part of a word here
  // means "cat" does NOT exact-match "cat-astrophy" — that's the
  // expected behavior for natural-language notes.
  const wordBoundary = new RegExp(
    `(^|[^\\w-])${escapeRegex(query)}($|[^\\w-])`,
    caseSensitive ? "g" : "gi",
  );

  const all: SearchMatch[] = [];
  for (const project of projects) {
    for (const name of FILES_TO_SCAN) {
      const filePath = join(project.handoffDir, name);
      const rel = join(".handoff", name).replace(/\\/g, "/");
      const hits = await scanFile(
        project,
        filePath,
        rel,
        query,
        caseSensitive,
        wordBoundary,
      );
      all.push(...hits);
    }
  }

  all.sort((a, b) => {
    // 1. exact-word matches first
    if (a.exactWord !== b.exactWord) return a.exactWord ? -1 : 1;
    // 2. more recent project first (null last)
    const aT = a.updatedAt ? a.updatedAt.getTime() : -Infinity;
    const bT = b.updatedAt ? b.updatedAt.getTime() : -Infinity;
    if (aT !== bT) return bT - aT;
    // 3. stable by project then file order then line number
    if (a.projectPath !== b.projectPath) {
      return a.projectPath < b.projectPath ? -1 : 1;
    }
    if (a.relativeFile !== b.relativeFile) {
      return (
        FILES_TO_SCAN.indexOf(a.relativeFile.replace(/^\.handoff\//, "")) -
        FILES_TO_SCAN.indexOf(b.relativeFile.replace(/^\.handoff\//, ""))
      );
    }
    return a.lineNumber - b.lineNumber;
  });

  const limited = limit > 0 ? all.slice(0, limit) : all;
  return { matches: limited, projectsScanned: projects.length };
}

/**
 * Format "time ago" for the project header. Keeps it short and
 * human-friendly — no dependency on a date library.
 */
function formatAgo(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

/**
 * CLI entry point: runs the search and prints grouped, human-friendly
 * output to stdout. Empty result set is NOT an error — prints a
 * status line and exits 0.
 */
export async function search(
  query: string,
  opts: SearchOpts = {},
): Promise<void> {
  if (!query || query.trim().length === 0) {
    console.error("handoff search: query is required");
    process.exitCode = 1;
    return;
  }

  const { matches, projectsScanned } = await searchProjects(query, opts);

  if (matches.length === 0) {
    console.log(
      `No matches for "${query}" across ${projectsScanned} project${projectsScanned === 1 ? "" : "s"}.`,
    );
    return;
  }

  // Group matches by project, preserving the already-ranked order of
  // first appearance per project.
  const groups = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const bucket = groups.get(m.projectPath);
    if (bucket) {
      bucket.push(m);
    } else {
      groups.set(m.projectPath, [m]);
    }
  }

  // Compute padding for the "relativeFile:lineNumber" column within a
  // project so the `→ line` output lines up nicely.
  const parts: string[] = [];
  let first = true;
  for (const [projectPath, projectMatches] of groups) {
    if (!first) parts.push("");
    first = false;
    const stamp = projectMatches[0]!.updatedAt;
    const ago = stamp ? ` (updated ${formatAgo(stamp)})` : "";
    parts.push(`${projectPath}${ago}`);
    const locWidth = Math.max(
      ...projectMatches.map((m) => `${m.relativeFile}:${m.lineNumber}`.length),
    );
    for (const m of projectMatches) {
      const loc = `${m.relativeFile}:${m.lineNumber}`.padEnd(locWidth);
      parts.push(`  ${loc}  \u2192 ${m.line}`);
    }
  }
  console.log(parts.join("\n"));
}

// Re-export so callers can grab types from one module.
export { discoverHandoffProjects };
export type { HandoffProject };
