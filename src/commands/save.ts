import { platform, release, arch, userInfo } from "node:os";
import { resolveHandoffPaths } from "../format/paths.js";
import { collectGitState } from "../util/git.js";
import { exists, writeJson, writeFileSafe, readOrEmpty } from "../util/fs.js";
import { loadMeta } from "../format/migrate.js";

const AUTO_HEADER = "## Auto";
const HUMAN_HEADER = "## Human notes";

export async function save(opts: { cwd?: string } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  const meta = await loadMeta(paths.meta);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    await writeJson(paths.meta, meta);
  }

  const git = await collectGitState(cwd);
  const envAuto = [
    `_refreshed: ${new Date().toISOString()}_`,
    ``,
    `- os: ${platform()} ${release()} (${arch()})`,
    `- user: ${safeUser()}`,
    `- node: ${process.version}`,
    `- cwd: \`${cwd}\``,
    git ? `- git branch: \`${git.branch ?? "(detached)"}\`` : `- git: (not a repo)`,
    git && git.status ? `\n### git status\n\n\`\`\`\n${git.status}\n\`\`\`` : null,
    git && git.lastCommits
      ? `\n### recent commits\n\n\`\`\`\n${git.lastCommits}\n\`\`\``
      : null,
    git && git.diffStat ? `\n### diff stat\n\n\`\`\`\n${git.diffStat}\n\`\`\`` : null,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  const existing = await readOrEmpty(paths.environment);
  const rebuilt = replaceAutoSection(existing, envAuto);
  await writeFileSafe(paths.environment, rebuilt);

  console.log(`saved at ${new Date().toISOString()}`);
  if (git) console.log(`git: ${git.branch ?? "(detached)"}, ${countLines(git.status)} changes`);
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "(unknown)";
  }
}

function countLines(s: string): number {
  if (!s.trim()) return 0;
  return s.trim().split("\n").length;
}

function replaceAutoSection(doc: string, newAuto: string): string {
  if (!doc.includes(AUTO_HEADER)) return doc;
  const autoIdx = doc.indexOf(AUTO_HEADER);
  const humanIdx = doc.indexOf(HUMAN_HEADER);
  const before = doc.slice(0, autoIdx + AUTO_HEADER.length);
  const after =
    humanIdx !== -1 && humanIdx > autoIdx ? "\n\n" + doc.slice(humanIdx) : "\n";
  return `${before}\n\n${newAuto}${after}`;
}
