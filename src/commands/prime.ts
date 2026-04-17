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
  subagent?: boolean;
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
  // --subagent wins over --compact. Otherwise --compact takes precedence;
  // --max-chars below threshold also triggers compact.
  const useSubagent = !!opts.subagent;
  const useCompact = !useSubagent && (opts.compact || maxChars < COMPACT_THRESHOLD);

  const output = useSubagent
    ? await buildSubagentPrimer(paths, opts.tool)
    : useCompact
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

  // Rate-limit protocol sits right after the preamble so it's the first
  // thing an agent registers — if they're about to hit a wall, we want
  // that top-of-mind before they read the task.
  parts.push({
    title: "Rate-limit protocol",
    body: rateLimitSection(tool, "full"),
  });

  const importedContext = cleanImportedContext(
    await readOrEmpty(paths.ingestedContext),
  );
  if (importedContext) {
    parts.push({
      title: "Imported session context",
      body: importedContext,
    });
  }

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
    meta && meta.sourceTool && meta.sourceTool !== "unknown"
      ? `\nSource tool: \`${meta.sourceTool}\`. Snapshot updated: ${meta.updatedAt}.`
      : "",
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
/**
 * Suggest a sibling tool to switch to when the current one is rate-limited.
 * Heuristic: swap Anthropic <-> OpenAI; third-party tools fall back to
 * claude-code as the most-common alternative.
 */
function suggestedSwitchTarget(tool: Tool): Tool {
  switch (tool) {
    case "claude-code":
      return "codex";
    case "codex":
      return "claude-code";
    case "cursor":
      return "claude-code";
    case "gemini":
      return "claude-code";
    default:
      return "codex";
  }
}

/**
 * Rate-limit protocol block. Tells the agent what signals mean "about to hit
 * a wall" and exactly which commands to run. Full variant is 8-12 lines;
 * compact is 4-6 lines.
 */
function rateLimitSection(tool: Tool, variant: "full" | "compact"): string {
  const target = suggestedSwitchTarget(tool);
  if (variant === "compact") {
    return [
      `Signals: latency spikes, \`429\`/rate-limit errors, user hits a cap, long pauses.`,
      `If any: log \`handoff correct "rate limit on ${tool}"\`, tell user \`handoff switch ${target}\`, summarize in-flight.`,
    ].join("\n");
  }
  return [
    `Watch for signals that this session is about to stall out:`,
    `- unusual latency on tool calls or model responses`,
    `- explicit \`rate limit\` / \`429\` errors from the underlying API`,
    `- the user saying they've hit a limit (quota, usage cap, "slow down")`,
    `- long pauses where the tool stops responding mid-turn`,
    ``,
    `When any of those fire, don't push through — hand off cleanly:`,
    `1. Log the event: \`handoff correct "hit rate limit on ${tool}" --user-said "(verbatim, if explicit)"\``,
    `2. Tell the user to run \`handoff switch ${target}\` (recommended fallback for ${tool}).`,
    `3. Briefly summarize what's in flight — current file, next step — so the next tool knows where to resume.`,
  ].join("\n");
}

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

function cleanImportedContext(raw: string): string {
  let s = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  s = s.replace(/\n*---\s*\n*_Next step for the reading agent:[\s\S]*$/m, "");
  s = s.replace(/\n*---\s*$/g, "").trim();
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

  // Rate-limit protocol — top-of-mind so the agent knows how to bail cleanly.
  parts.push(`## Rate-limit protocol\n\n${rateLimitSection(tool, "compact")}`);

  // 1. Task — full if short, pointer if long.
  const taskRaw = cleanBody(await readOrEmpty(paths.task));
  if (taskRaw) {
    const taskBody =
      taskRaw.length > 500
        ? `${taskRaw.slice(0, 500).trimEnd()}...(see .handoff/task.md for full)`
        : taskRaw;
    parts.push(`## Task\n\n${taskBody}`);
  }

  const importedContext = cleanImportedContext(
    await readOrEmpty(paths.ingestedContext),
  );
  if (importedContext) {
    parts.push(
      "## Imported session context\n\n" +
        "A past-session summary was imported into `.handoff/ingested-context.md`. " +
        "Read that file if this handoff needs transcript-level context beyond the task/open-loops snapshot.",
    );
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

/**
 * Subagent primer: for a task-subagent spawned from a parent session (e.g.
 * Claude Code's `Agent` tool). The subagent inherits `CLAUDE.md` but not
 * the parent's transient state, so it needs the parent's task + recent
 * corrections/attempts — but NOT the full environment/decisions/codebase-map
 * (it's focused on one subtask) and it must NOT write back to `.handoff/`
 * (parent is the source of truth). Rate-limit handoffs are the parent's
 * call, so that section is dropped too.
 *
 * Target: ~1500 chars on a realistic fixture.
 */
export async function buildSubagentPrimer(
  paths: HandoffPaths,
  _tool: Tool,
): Promise<string> {
  const parts: string[] = [];
  parts.push(`# HANDOFF PRIMER (subagent)`);
  parts.push(
    [
      `You are a subagent spawned from a parent session using handoff.`,
      `Do NOT modify \`.handoff/\` files — let the parent log events (attempts, corrections, decisions).`,
      `Do NOT run \`handoff switch\` — the parent decides when to hand off.`,
      `You're a focused helper on ONE subtask; use the context below to avoid repeating mistakes the parent already learned from.`,
    ].join("\n"),
  );

  // Task — full, so the subagent knows the overarching goal.
  const taskRaw = cleanBody(await readOrEmpty(paths.task));
  if (taskRaw) {
    parts.push(`## Task (parent's goal)\n\n${taskRaw}`);
  }

  // Latest 3 corrections — highest-signal "don't repeat this" input.
  const correctionsRaw = await readOrEmpty(paths.corrections);
  const recentCorrections = lastNEntries(correctionsRaw, 3);
  if (recentCorrections.length > 0) {
    const total = splitEntries(correctionsRaw).length;
    const omitted = total - recentCorrections.length;
    const ptr =
      omitted > 0
        ? `\n\n_(showing latest ${recentCorrections.length} of ${total})_`
        : "";
    parts.push(
      `## Latest corrections\n\n${recentCorrections.join("\n\n---\n\n")}${ptr}`,
    );
  }

  // Latest 3 failed attempts — same rationale.
  const attemptsRaw = await readOrEmpty(paths.attempts);
  const recentAttempts = lastNEntries(attemptsRaw, 3);
  if (recentAttempts.length > 0) {
    const total = splitEntries(attemptsRaw).length;
    const omitted = total - recentAttempts.length;
    const ptr =
      omitted > 0
        ? `\n\n_(showing latest ${recentAttempts.length} of ${total})_`
        : "";
    parts.push(
      `## Latest failed attempts (do not repeat)\n\n${recentAttempts.join("\n\n---\n\n")}${ptr}`,
    );
  }

  return parts.join("\n\n") + "\n";
}
