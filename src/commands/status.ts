import { resolveHandoffPaths } from "../format/paths.js";
import { exists, readOrEmpty } from "../util/fs.js";
import { loadMeta } from "../format/migrate.js";

type Row = { file: string; status: string; size: number };

export async function status(opts: { cwd?: string } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not found in", cwd);
    console.error("run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  const meta = await loadMeta(paths.meta);
  if (meta) {
    console.log("meta:");
    console.log("  source:     ", meta.sourceTool);
    console.log("  created:    ", meta.createdAt);
    console.log("  updated:    ", meta.updatedAt);
    console.log("  project:    ", meta.projectRoot);
    console.log();
  }

  const checks: Array<{ label: string; path: string }> = [
    { label: "task.md", path: paths.task },
    { label: "progress.md", path: paths.progress },
    { label: "decisions.md", path: paths.decisions },
    { label: "attempts.md", path: paths.attempts },
    { label: "corrections.md", path: paths.corrections },
    { label: "identity.md", path: paths.identity },
    { label: "environment.md", path: paths.environment },
    { label: "codebase-map.md", path: paths.codebaseMap },
    { label: "open-loops.md", path: paths.openLoops },
    { label: "references.md", path: paths.references },
  ];

  const rows: Row[] = [];
  for (const c of checks) {
    const content = await readOrEmpty(c.path);
    const substantive = stripTemplate(content).trim().length;
    rows.push({
      file: c.label,
      status: substantive > 0 ? "filled" : "template",
      size: content.length,
    });
  }

  const width = Math.max(...rows.map((r) => r.file.length));
  console.log("contents:");
  for (const r of rows) {
    const mark = r.status === "filled" ? "●" : "○";
    console.log(`  ${mark} ${r.file.padEnd(width)}  ${r.status.padEnd(8)}  ${r.size}b`)
  }
}

function stripTemplate(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").replace(/^#.*$/gm, "").replace(/^##.*$/gm, "");
}
