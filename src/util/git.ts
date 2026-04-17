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
