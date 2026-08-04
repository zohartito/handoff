import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTrustedExecutable } from "./executable.js";

const run = promisify(execFile);

async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const git = await resolveTrustedExecutable("git", cwd);
    if (!git) return null;
    const { stdout } = await run(git, args, { cwd, maxBuffer: 4 * 1024 * 1024, shell: false });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Count commits whose commit date is newer than `sinceIso` on the current
 * HEAD. Mirrors the `tryGit` failure contract: returns null when this isn't a
 * git repo, there's no HEAD yet, or the command fails for any reason.
 */
export async function commitsSince(cwd: string, sinceIso: string): Promise<number | null> {
  const out = await tryGit(["rev-list", "--count", `--since=${sinceIso}`, "HEAD"], cwd);
  if (out === null) return null;
  const n = Number.parseInt(out, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Count commits that landed after the last one to touch `absPath`. Returns
 * null when the path was never committed (git log yields an empty sha), when
 * this isn't a repo, or on any git failure.
 */
export async function commitsSincePathChange(cwd: string, absPath: string): Promise<number | null> {
  const sha = await tryGit(["log", "-1", "--format=%H", "--", absPath], cwd);
  if (!sha) return null; // never committed (empty stdout) or not a repo
  const out = await tryGit(["rev-list", "--count", `${sha}..HEAD`], cwd);
  if (out === null) return null;
  const n = Number.parseInt(out, 10);
  return Number.isNaN(n) ? null : n;
}

export async function collectGitState(cwd: string) {
  const isRepo = (await tryGit(["rev-parse", "--is-inside-work-tree"], cwd)) === "true";
  if (!isRepo) return null;

  const [branch, status, lastCommits, diffStat] = await Promise.all([
    tryGit(["branch", "--show-current"], cwd),
    tryGit(["status", "--short"], cwd),
    tryGit(["log", "-5", "--oneline"], cwd),
    tryGit(["diff", "--stat"], cwd),
  ]);

  return {
    branch: branch ?? null,
    status: status ?? "",
    lastCommits: lastCommits ?? "",
    diffStat: diffStat ?? "",
  };
}
