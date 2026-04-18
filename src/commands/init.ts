import { resolveHandoffPaths } from "../format/paths.js";
import { templates, initialMeta, initialFilesManifest } from "../format/templates.js";
import {
  exists,
  ensureDir,
  writeFileSafe,
  writeJson,
} from "../util/fs.js";

type InitOpts = { from?: string; force?: boolean; cwd?: string };

export async function init(opts: InitOpts = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if ((await exists(paths.dir)) && !opts.force) {
    console.error(`.handoff/ already exists at ${paths.dir}`);
    console.error("use --force to overwrite");
    process.exitCode = 1;
    return;
  }

  await ensureDir(paths.dir);

  for (const [name, body] of Object.entries(templates)) {
    const target = resolveTemplateTarget(paths, name);
    await writeFileSafe(target, body);
  }

  await writeJson(paths.meta, initialMeta(opts.from ?? "unknown", cwd));
  await writeJson(paths.filesManifest, initialFilesManifest());
  // Note: we intentionally do NOT pre-create transcript.jsonl or
  // tool-history.jsonl here. They are append-only logs that `handoff capture`
  // and `handoff ingest` create on first write. Pre-creating them as empty
  // 1-byte files was misleading — follow-up agents opened them expecting
  // history and found nothing, wasting a tool call.

  console.log(`initialized .handoff/ at ${paths.dir}`);
  console.log("source tool:", opts.from ?? "unknown");
  console.log("\nnext:");
  console.log("  1. fill in .handoff/task.md (what are we building)");
  console.log("  2. fill in .handoff/identity.md (user's style)");
  console.log("  3. work as normal. log as you go:");
  console.log("     handoff attempt \"tried X\" --error \"trace\" --fix \"what worked\"");
  console.log("     handoff decide \"chose X\" --because \"reason\"");
  console.log("     handoff correct \"what I did\" --user-said \"their feedback\"");
  console.log("  4. when handing off: handoff prime <target-tool>");
}

function resolveTemplateTarget(paths: ReturnType<typeof resolveHandoffPaths>, name: string): string {
  const mapping: Record<string, string> = {
    "HANDOFF.md": paths.handoffMd,
    "task.md": paths.task,
    "progress.md": paths.progress,
    "decisions.md": paths.decisions,
    "attempts.md": paths.attempts,
    "corrections.md": paths.corrections,
    "identity.md": paths.identity,
    "environment.md": paths.environment,
    "codebase-map.md": paths.codebaseMap,
    "open-loops.md": paths.openLoops,
    "references.md": paths.references,
  };
  const target = mapping[name];
  if (!target) throw new Error(`no path mapping for template: ${name}`);
  return target;
}
