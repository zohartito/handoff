import { resolveHandoffPaths, type HandoffPaths } from "../format/paths.js";
import { exists, readOrEmpty, readJson } from "../util/fs.js";
import type { Meta } from "../format/types.js";

export type Tool = "claude-code" | "cursor" | "codex" | "gemini" | "generic";

type PrimeOpts = {
  tool: Tool;
  maxChars?: number;
  cwd?: string;
};

export async function prime(opts: PrimeOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not found. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  const output = await buildPrimer(paths, opts.tool, opts.maxChars ?? Infinity);
  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
}

export async function buildPrimer(
  paths: HandoffPaths,
  tool: Tool,
  maxChars: number,
): Promise<string> {
  const meta = await readJson<Meta>(paths.meta);
  const parts: Array<{ title: string; body: string }> = [];

  parts.push({
    title: "Preamble",
    body: preambleFor(tool, meta),
  });

  const sections: Array<{ label: string; path: string }> = [
    { label: "Task", path: paths.task },
    { label: "Progress", path: paths.progress },
    { label: "Decisions made", path: paths.decisions },
    { label: "Failed attempts (do not repeat)", path: paths.attempts },
    { label: "User corrections (the real rubric)", path: paths.corrections },
    { label: "Identity / style", path: paths.identity },
    { label: "Environment", path: paths.environment },
    { label: "Codebase map", path: paths.codebaseMap },
    { label: "Open loops", path: paths.openLoops },
    { label: "References", path: paths.references },
  ];

  for (const s of sections) {
    const raw = await readOrEmpty(s.path);
    const body = cleanBody(raw);
    if (!body) continue;
    parts.push({ title: s.label, body });
  }

  const assembled = parts.map((p) => `## ${p.title}\n\n${p.body}`).join("\n\n---\n\n");
  const withHeader = `# HANDOFF PRIMER\n\n${assembled}\n`;

  return withHeader.length > maxChars ? truncate(withHeader, maxChars) : withHeader;
}

function preambleFor(tool: Tool, meta: Meta | null): string {
  const common = [
    `You are an AI coding agent picking up work that was previously in progress.`,
    `The full handoff artifact is in the \`.handoff/\` directory at the project root.`,
    `Read every section below before taking any action.`,
    meta ? `\nSource tool: \`${meta.sourceTool}\`. Snapshot updated: ${meta.updatedAt}.` : "",
  ];

  const toolNote: Record<Tool, string> = {
    "claude-code":
      "You are Claude Code. After reading this, also re-read project CLAUDE.md if present.",
    cursor: "You are Cursor. After reading this, also re-read .cursorrules if present.",
    codex:
      "You are Codex / OpenAI coding agent. Treat everything below as additional system prompt context.",
    gemini:
      "You are Gemini. Treat everything below as additional system prompt context. You can @-reference files in `.handoff/` directly.",
    generic:
      "Treat everything below as additional system prompt context for this session.",
  };

  return [...common, "", toolNote[tool]].filter(Boolean).join("\n");
}

function cleanBody(raw: string): string {
  let s = raw.replace(/<!--[\s\S]*?-->/g, "");
  // drop the top-level `# Title` line — we supply our own section heading
  s = s.replace(/^#\s+[^\n]*\n/, "");
  // trim surrounding whitespace and trailing `---` dividers
  s = s.replace(/\n*---\s*$/g, "").trim();
  // if only empty subheadings remain (e.g. "## Done\n\n## Next"), drop it
  const meaningful = s
    .split("\n")
    .filter((line) => line.trim() && !/^#+\s/.test(line))
    .join("\n")
    .trim();
  if (!meaningful) return "";
  return s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.85);
  const tail = max - head - 80;
  return `${s.slice(0, head)}\n\n...[truncated ${s.length - max} chars]...\n\n${s.slice(-tail)}`;
}
