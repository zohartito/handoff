import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export interface HandoffProject {
  projectPath: string;
  handoffDir: string;
  updatedAt: Date | null;
}

export interface DiscoverOpts {
  roots?: string[];
  maxDepth?: number;
}

// Directories that should never be descended into while walking for
// .handoff/ folders. These are either dependency caches, VCS internals,
// or build artifacts — a real project root will never live inside one.
const SKIP_DIR_NAMES = new Set<string>([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
]);

const DEFAULT_CANDIDATE_SUBDIRS = [
  "code",
  "repos",
  "dev",
  "projects",
  "src",
  "work",
  "Documents/GitHub",
  "SynologyDrive",
];

/**
 * Compute the default set of roots to scan when the caller hasn't
 * passed `roots` and the HANDOFF_SEARCH_ROOTS env var is unset.
 * Always includes the home directory, plus any of the common project
 * parent directories that actually exist as directories.
 */
async function defaultRoots(): Promise<string[]> {
  const home = homedir();
  const roots: string[] = [home];
  for (const sub of DEFAULT_CANDIDATE_SUBDIRS) {
    const candidate = resolve(home, sub);
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) roots.push(candidate);
    } catch {
      // missing candidate — skip silently
    }
  }
  return roots;
}

/**
 * Parse HANDOFF_SEARCH_ROOTS using the platform's PATH delimiter
 * (`;` on Windows, `:` on POSIX). A mixed-delimiter split would
 * chop Windows drive-letter paths at the `:` in `C:\...`.
 */
function parseEnvRoots(raw: string): string[] {
  return raw
    .split(delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Try to read meta.json and extract updatedAt as a Date. Unreadable
 * files, invalid JSON, and missing/invalid `updatedAt` all collapse
 * to null — discovery never fails just because one meta is bad.
 */
async function readUpdatedAt(metaPath: string): Promise<Date | null> {
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const updatedAt = (obj as Record<string, unknown>).updatedAt;
    if (typeof updatedAt !== "string") return null;
    const d = new Date(updatedAt);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Recursively walk from `dir` up to `maxDepth` levels, collecting
 * every directory that contains a `.handoff/meta.json`. When such a
 * directory is found we record it but DO NOT descend into it — a
 * .handoff/ project won't usefully contain more .handoff/ projects,
 * and avoiding the descent keeps walks cheap.
 */
async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  found: Map<string, HandoffProject>,
): Promise<void> {
  if (depth > maxDepth) return;

  const metaPath = join(dir, ".handoff", "meta.json");
  let metaExists = false;
  try {
    const st = await fs.stat(metaPath);
    metaExists = st.isFile();
  } catch {
    metaExists = false;
  }

  if (metaExists) {
    if (!found.has(dir)) {
      const updatedAt = await readUpdatedAt(metaPath);
      found.set(dir, {
        projectPath: dir,
        handoffDir: join(dir, ".handoff"),
        updatedAt,
      });
    }
    // Don't descend further — .handoff projects don't nest.
    return;
  }

  if (depth === maxDepth) return;

  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    const raw = await fs.readdir(dir, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    // Don't descend into `.handoff` itself if we hit it without a meta
    // (corrupt/partial install); also skip other dotfolders that are
    // unlikely to contain projects.
    if (entry.name === ".handoff") continue;
    const child = join(dir, entry.name);
    await walk(child, depth + 1, maxDepth, found);
  }
}

/**
 * Discover every `.handoff/`-bearing project under the configured
 * search roots. Results are deduplicated by project path and sorted
 * by `updatedAt` descending; projects without an `updatedAt` sort
 * last in insertion order.
 */
export async function discoverHandoffProjects(
  opts: DiscoverOpts = {},
): Promise<HandoffProject[]> {
  const maxDepth = opts.maxDepth ?? 5;

  let roots: string[];
  if (opts.roots && opts.roots.length > 0) {
    roots = opts.roots;
  } else {
    const envRaw = process.env.HANDOFF_SEARCH_ROOTS;
    if (envRaw && envRaw.trim().length > 0) {
      roots = parseEnvRoots(envRaw);
    } else {
      roots = await defaultRoots();
    }
  }

  const found = new Map<string, HandoffProject>();
  for (const root of roots) {
    const resolved = resolve(root);
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    await walk(resolved, 0, maxDepth, found);
  }

  const list = Array.from(found.values());
  list.sort((a, b) => {
    if (a.updatedAt && b.updatedAt) {
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    }
    if (a.updatedAt) return -1;
    if (b.updatedAt) return 1;
    return 0;
  });
  return list;
}
