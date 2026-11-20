import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function tryGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Preserve exit codes for predicates such as `git check-ignore -q`. */
async function tryGitExitCode(args: string[], cwd: string): Promise<number | null> {
  try {
    await run("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return 0;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "number" ? code : null;
  }
}

/**
 * Report directory tracking from Git's index, not just ignore rules: a tracked
 * file stays tracked even if a later ignore rule matches. Returns null outside
 * a work tree or when Git cannot determine the state.
 */
export async function handoffTrackingState(
  cwd: string,
  relDir: string,
): Promise<"tracked" | "ignored" | "untracked" | null> {
  if ((await tryGit(["rev-parse", "--is-inside-work-tree"], cwd)) !== "true") return null;
  const tracked = await tryGit(["ls-files", "--", relDir], cwd);
  if (tracked === null) return null;
  if (tracked) return "tracked";
  const code = await tryGitExitCode(["check-ignore", "-q", "--", relDir], cwd);
  if (code === 0) return "ignored";
  return code === 1 ? "untracked" : null;
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
