import { resolveHandoffPaths, type HandoffPaths } from "../format/paths.js";
import { exists, readOrEmpty } from "../util/fs.js";
import type { Meta } from "../format/types.js";
import { loadMeta } from "../format/migrate.js";

export type Tool = "claude-code" | "cursor" | "codex" | "gemini" | "generic";

/**
 * Threshold at which --max-chars implicitly switches to compact mode.
 * The full primer has fixed framing overhead plus whatever the user has
 * written, so anything under 2000 chars is better served by the compact
 * layout than by mid-file truncation (which drops the most recent
 * corrections/attempts in favor of middle boilerplate).
 */
export const COMPACT_THRESHOLD = 2000;

type PrimeOpts = {
  tool: Tool;
  maxChars?: number;
  compact?: boolean;
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

  const maxChars = opts.maxChars ?? Infinity;
  // --compact takes precedence; --max-chars below threshold also triggers compact
  const useCompact = opts.compact || maxChars < COMPACT_THRESHOLD;

  const output = useCompact
    ? await buildCompactPrimer(paths, opts.tool)
    : await buildPrimer(paths, opts.tool, maxChars);

  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
}

export async function buildPrimer(
  paths: HandoffPaths,
  tool: Tool,
  maxChars: number,
): Promise<string> {
  const meta = await loadMeta(paths.meta);
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
    codex: [
      "You are Codex / OpenAI coding agent. Treat everything below as additional system prompt context.",
      "Your tools here are `shell`, `read_file`, `write_file`, and `apply_patch`.",
      "If a logged attempt mentions Claude Code's `Edit` or `Bash`, those map to your `apply_patch` and `shell` respectively — the intent carries over.",
      "Open `.handoff/task.md` with `read_file` before making any change.",
    ].join("\n"),
    gemini: [
      "You are Gemini. Treat everything below as additional system prompt context.",
      "Your tools are `read_file`, `write_file`, `run_shell_command`, and glob/grep search.",
      "You can @-reference files directly — e.g. `@.handoff/task.md`, `@.handoff/open-loops.md` — to pull them into context on demand instead of re-reading this whole primer.",
      "When in doubt about what to do next, @.handoff/open-loops.md first.",
    ].join("\n"),
    generic:
      "Treat everything below as additional system prompt context for this session.",
  };

  return [...common, "", toolNote[tool]].filter(Boolean).join("\n");
}

/**
 * Short preamble used inside the compact primer.
 * Keeps the per-tool tool-name hint (apply_patch / @-reference / etc.) but
 * drops the "read every section below" framing — compact mode only has a
 * handful of sections, all short.
 */
function compactPreambleFor(tool: Tool): string {
  const header =
    "You are an AI agent resuming work. This is a handoff — treat it as system context.";
  const toolLine: Record<Tool, string> = {
    "claude-code":
      "You are Claude Code. Also re-read project CLAUDE.md if present.",
    cursor: "You are Cursor. Also re-read .cursorrules if present.",
    codex:
      "You are Codex. Your tools are `shell`, `read_file`, `write_file`, `apply_patch`. Prior Claude Code `Edit`/`Bash` attempts map to your `apply_patch`/`shell`.",
    gemini:
      "You are Gemini. Use @-reference to pull files on demand (e.g. `@.handoff/open-loops.md`). Tools: `read_file`, `write_file`, `run_shell_command`.",
    generic: "Treat this as additional system prompt context.",
  };
  return `${header}\n${toolLine[tool]}`;
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

/**
 * Split a markdown doc (`attempts.md`, `corrections.md`) into its top-level
 * entries. Entries are appended by `handoff attempt|correct` using a
 * `## <ISO-timestamp>` header followed by a trailing `---`. We split on
 * `## ` headers when present; fall back to `\n---\n` separators otherwise.
 *
 * Returns entries in original order, with the file's `# Title` + HTML
 * comment banner stripped.
 */
export function splitEntries(raw: string): string[] {
  const cleaned = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/^#\s+[^\n]*\n/, "");
  const trimmed = cleaned.trim();
  if (!trimmed) return [];

  // Primary strategy: split on `## ` H2 headers (what attempt/correct emit).
  if (/^## /m.test(trimmed)) {
    const parts = trimmed.split(/\n(?=## )/g);
    return parts
      .map((p) => p.replace(/\n---\s*$/g, "").trim())
      .filter((p) => p.length > 0);
  }

  // Fallback: entries separated only by `---` dividers.
  return trimmed
    .split(/\n---\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Return the last N entries from a markdown doc, preserving original order. */
export function lastNEntries(raw: string, n: number): string[] {
  const entries = splitEntries(raw);
  return entries.slice(-n);
}

/**
 * Compact primer: task-focused, < 2k chars for a typical project.
 * Drops decisions/codebase-map/references/identity (agent can read those
 * on demand) and keeps only the latest 3 attempts and 3 corrections —
 * the freshest signal of what the user wants.
 */
export async function buildCompactPrimer(
  paths: HandoffPaths,
  tool: Tool,
): Promise<string> {
  const parts: string[] = [];
  parts.push(`# HANDOFF PRIMER (compact)`);
  parts.push(compactPreambleFor(tool));

  // 1. Task — full if short, pointer if long.
  const taskRaw = cleanBody(await readOrEmpty(paths.task));
  if (taskRaw) {
    const taskBody =
      taskRaw.length > 500
        ? `${taskRaw.slice(0, 500).trimEnd()}...(see .handoff/task.md for full)`
        : taskRaw;
    parts.push(`## Task\n\n${taskBody}`);
  }

  // 2. Open loops — always full (tiny by nature).
  const openLoops = cleanBody(await readOrEmpty(paths.openLoops));
  if (openLoops) {
    parts.push(`## Open loops\n\n${openLoops}`);
  }

  // 3. Latest 3 corrections.
  const correctionsRaw = await readOrEmpty(paths.corrections);
  const recentCorrections = lastNEntries(correctionsRaw, 3);
  if (recentCorrections.length > 0) {
    const total = splitEntries(correctionsRaw).length;
    const omitted = total - recentCorrections.length;
    const ptr =
      omitted > 0
        ? `\n\n_(showing latest ${recentCorrections.length} of ${total}; see \`.handoff/corrections.md\` for the rest)_`
        : "";
    parts.push(
      `## Latest corrections\n\n${recentCorrections.join("\n\n---\n\n")}${ptr}`,
    );
  }

  // 4. Latest 3 failed attempts.
  const attemptsRaw = await readOrEmpty(paths.attempts);
  const recentAttempts = lastNEntries(attemptsRaw, 3);
  if (recentAttempts.length > 0) {
    const total = splitEntries(attemptsRaw).length;
    const omitted = total - recentAttempts.length;
    const ptr =
      omitted > 0
        ? `\n\n_(showing latest ${recentAttempts.length} of ${total}; see \`.handoff/attempts.md\` for the rest)_`
        : "";
    parts.push(
      `## Latest failed attempts (do not repeat)\n\n${recentAttempts.join("\n\n---\n\n")}${ptr}`,
    );
  }

  // 5. Environment — squeeze to one line.
  const envLine = extractEnvOneLine(await readOrEmpty(paths.environment));
  if (envLine) {
    parts.push(`## Environment\n\n${envLine}`);
  }

  return parts.join("\n\n") + "\n";
}

/**
 * Extract os / node / git-branch from environment.md into a single line.
 * The auto-generated section uses `- **key:** value` bullets; we pick a
 * few high-signal keys and format as `os: linux | node: 22.11.0 | branch: main`.
 * Falls back to "" if nothing recognizable is found.
 */
function extractEnvOneLine(raw: string): string {
  if (!raw.trim()) return "";
  const lines = raw.split("\n");
  const pick = (label: RegExp): string | null => {
    for (const line of lines) {
      const m = line.match(/^\s*[-*]\s*\*\*([^*]+)\*\*:?\s*(.+?)\s*$/);
      if (m && label.test(m[1])) return m[2];
    }
    return null;
  };

  const os = pick(/^(os|platform|operating system)/i);
  const node = pick(/^(node|node\.?js|runtime)/i);
  const branch = pick(/^(git branch|branch|git)/i);

  const parts: string[] = [];
  if (os) parts.push(`os: ${os}`);
  if (node) parts.push(`node: ${node}`);
  if (branch) parts.push(`branch: ${branch}`);
  return parts.join(" | ");
}
