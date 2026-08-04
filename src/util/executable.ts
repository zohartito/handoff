import { promises as fs } from "node:fs";
import { delimiter, relative, resolve } from "node:path";

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

async function canonical(path: string): Promise<string | null> {
  try { return await fs.realpath(path); } catch { return null; }
}

async function regularExecutable(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return false;
    return process.platform === "win32" || (stat.mode & 0o111) !== 0;
  } catch { return false; }
}

/**
 * Resolve before chdir into an untrusted checkout. Every object in the
 * decision (workspace, PATH directory, and executable) is realpath'd, so a
 * repository alias or PATH-directory symlink cannot smuggle a local shim in.
 * Windows deliberately accepts only native .exe/.com binaries. npm's .cmd
 * shims are rejected until a trusted node+package entrypoint is configured.
 */
export async function resolveTrustedExecutable(command: string, workspace: string): Promise<string | null> {
  const canonicalWorkspace = await canonical(workspace);
  if (!canonicalWorkspace) return null;
  const checkCandidate = async (candidate: string): Promise<string | null> => {
    const resolved = await canonical(candidate);
    if (!resolved || within(resolved, canonicalWorkspace) || !(await regularExecutable(resolved))) return null;
    return resolved;
  };

  if (command.includes("/") || command.includes("\\")) return await checkCandidate(resolve(command));

  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  // Never honour caller-controlled PATHEXT. .cmd/.bat requires cmd.exe and
  // therefore reintroduces command-string parsing in the untrusted cwd.
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const entry of rawPath.split(delimiter)) {
    if (!entry) continue;
    const base = await canonical(resolve(entry));
    if (!base || within(base, canonicalWorkspace)) continue;
    for (const extension of extensions) {
      const trusted = await checkCandidate(resolve(base, command + extension));
      if (trusted) return trusted;
    }
  }
  return null;
}
