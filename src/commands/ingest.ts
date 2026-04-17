import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exists, readOrEmpty } from "../util/fs.js";
import { ingestCursor } from "../adapters/cursor.js";
import { ingestCodex } from "../adapters/codex.js";
import { ingestGemini } from "../adapters/gemini.js";

export type IngestFrom = "claude-code" | "cursor" | "codex" | "gemini";

export type IngestOpts = {
  from: IngestFrom;
  session?: string; // session id or "latest"
  list?: boolean;
  out?: string;
  project?: string; // project path to scope session discovery
  cwd?: string;
};

type AnyEvent = Record<string, any>;

/**
 * Subcommand: `handoff ingest --from <tool> [--session <id|latest>] [--list] [--out <path>]`
 *
 * Reads a past AI-agent session transcript and emits a structured, agent-friendly
 * markdown summary. The calling agent then uses that summary to populate .handoff/
 * in the current project. Output shape is identical across source tools so
 * downstream processing is uniform.
 */
export async function ingest(opts: IngestOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const project = opts.project ? resolve(opts.project) : cwd;

  if (opts.from === "claude-code") {
    await ingestClaudeCode(opts, project);
    return;
  }
  if (opts.from === "cursor") {
    await ingestCursor({
      session: opts.session,
      list: opts.list,
      out: opts.out,
      project,
    });
    return;
  }
  if (opts.from === "codex") {
    await ingestCodex({
      session: opts.session,
      list: opts.list,
      out: opts.out,
      project,
    });
    return;
  }
  if (opts.from === "gemini") {
    await ingestGemini({
      session: opts.session,
      list: opts.list,
      out: opts.out,
      project,
    });
    return;
  }

  console.error(
    `ingest --from ${opts.from} not supported yet. known sources: claude-code, cursor, codex, gemini.`,
  );
  process.exitCode = 1;
}

async function ingestClaudeCode(opts: IngestOpts, project: string): Promise<void> {
  const projectDirs = await findClaudeProjectDirs(project);
  if (projectDirs.length === 0) {
    console.error(
      `no Claude Code sessions found for ${project}\n` +
        `(looked in ~/.claude/projects/ for folders matching this path or its parents)`,
    );
    process.exitCode = 1;
    return;
  }

  if (opts.list) {
    const summaries = await listSessionsAcross(projectDirs);
    printSessionList(summaries, projectDirs);
    return;
  }

  const sessionId = opts.session ?? "latest";
  const sessionFile = await resolveSessionFileAcross(projectDirs, sessionId);
  if (!sessionFile) {
    const summaries = await listSessionsAcross(projectDirs);
    const ids = summaries.slice(0, 5).map((s) => s.id.slice(0, 8)).join(", ");
    console.error(
      `session not found: ${sessionId}\n` +
        `  searched: ${projectDirs.join(", ")}\n` +
        (ids ? `  available (most recent): ${ids}` : `  no sessions in any dir`),
    );
    process.exitCode = 1;
    return;
  }

  const output = await summarizeSession(sessionFile);
  await emitOutput(output, opts.out);
}

export async function emitOutput(output: string, outFile: string | undefined): Promise<void> {
  if (outFile) {
    await fs.writeFile(outFile, output, "utf8");
    console.error(`wrote ingest summary → ${outFile}`);
  } else {
    process.stdout.write(output);
    if (!output.endsWith("\n")) process.stdout.write("\n");
  }
}

// ------------- session discovery -------------

/**
 * Claude Code normalizes project paths into folder names under
 * ~/.claude/projects/, by replacing `:`, `\`, `/`, and `_` all with `-`.
 *
 *   C:\Users\zohar_4ta16fp\handoff  →  C--Users-zohar-4ta16fp-handoff
 */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[:\\/_]/g, "-");
}

/**
 * Find ALL Claude Code project dirs that could contain sessions for this
 * project — the direct match plus any existing parent-path matches.
 *
 * Why aggregate: Claude Code sometimes logs a session's cwd as the parent
 * dir (when you run `claude` from the parent and navigate inside), so the
 * history for `C:\Users\me\foo` can live under `C--Users-me` OR
 * `C--Users-me-foo`. We want both.
 */
async function findClaudeProjectDirs(projectPath: string): Promise<string[]> {
  const base = join(homedir(), ".claude", "projects");
  if (!(await exists(base))) return [];
  const dirs: string[] = [];
  let p = projectPath;
  for (let i = 0; i < 8; i++) {
    const enc = encodeProjectPath(p);
    const candidate = join(base, enc);
    if (await exists(candidate)) dirs.push(candidate);
    const parent = p.replace(/[\\/][^\\/]+$/, "");
    if (!parent || parent === p) break;
    p = parent;
  }
  return dirs;
}

export type SessionSummary = {
  id: string;
  file: string;
  size: number;
  mtime: Date;
  firstUserMsg: string | null;
  firstTs: string | null;
  lastTs: string | null;
  userMsgCount: number;
  assistantCount: number;
  cwd: string | null;
};

async function listSessions(projectDir: string): Promise<SessionSummary[]> {
  const entries = await fs.readdir(projectDir);
  const jsonls = entries.filter((f) => f.endsWith(".jsonl"));
  const results: SessionSummary[] = [];
  for (const f of jsonls) {
    const full = join(projectDir, f);
    const stat = await fs.stat(full);
    const summary = await quickSummarize(full);
    results.push({
      id: f.replace(/\.jsonl$/, ""),
      file: full,
      size: stat.size,
      mtime: stat.mtime,
      ...summary,
    });
  }
  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results;
}

async function listSessionsAcross(projectDirs: string[]): Promise<SessionSummary[]> {
  const all: SessionSummary[] = [];
  for (const d of projectDirs) {
    const sessions = await listSessions(d);
    all.push(...sessions);
  }
  all.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return all;
}

async function quickSummarize(file: string): Promise<{
  firstUserMsg: string | null;
  firstTs: string | null;
  lastTs: string | null;
  userMsgCount: number;
  assistantCount: number;
  cwd: string | null;
}> {
  const raw = await readOrEmpty(file);
  const lines = raw.split("\n").filter(Boolean);
  let firstUserMsg: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let userMsgCount = 0;
  let assistantCount = 0;
  let cwd: string | null = null;
  for (const line of lines) {
    let e: AnyEvent;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.timestamp) {
      if (!firstTs) firstTs = e.timestamp;
      lastTs = e.timestamp;
    }
    if (e.cwd && !cwd) cwd = e.cwd;
    if (e.type === "user" && typeof e.message?.content === "string") {
      userMsgCount++;
      if (!firstUserMsg) firstUserMsg = e.message.content.trim().slice(0, 120);
    }
    if (e.type === "assistant") assistantCount++;
  }
  return { firstUserMsg, firstTs, lastTs, userMsgCount, assistantCount, cwd };
}

async function resolveSessionFile(
  projectDir: string,
  sessionId: string,
): Promise<string | null> {
  if (sessionId === "latest") {
    const sessions = await listSessions(projectDir);
    return sessions[0]?.file ?? null;
  }
  const direct = join(projectDir, `${sessionId}.jsonl`);
  if (await exists(direct)) return direct;
  // allow short prefix match
  const entries = await fs.readdir(projectDir);
  const match = entries.find((f) => f.startsWith(sessionId) && f.endsWith(".jsonl"));
  return match ? join(projectDir, match) : null;
}

async function resolveSessionFileAcross(
  projectDirs: string[],
  sessionId: string,
): Promise<string | null> {
  if (sessionId === "latest") {
    const sessions = await listSessionsAcross(projectDirs);
    return sessions[0]?.file ?? null;
  }
  for (const d of projectDirs) {
    const hit = await resolveSessionFile(d, sessionId);
    if (hit) return hit;
  }
  return null;
}

function printSessionList(sessions: SessionSummary[], projectDirs: string[]): void {
  process.stdout.write(`# Claude Code sessions\n\n`);
  process.stdout.write(`Searched project dirs:\n`);
  for (const d of projectDirs) process.stdout.write(`- ${d}\n`);
  process.stdout.write("\n");
  if (sessions.length === 0) {
    process.stdout.write("(none found)\n");
    return;
  }
  for (const s of sessions) {
    const short = s.id.slice(0, 8);
    const when = s.mtime.toISOString().replace("T", " ").slice(0, 16);
    const sizeKb = Math.round(s.size / 1024);
    const msg = s.firstUserMsg ? s.firstUserMsg.replace(/\s+/g, " ") : "(no user msg)";
    const cwd = s.cwd ? `  cwd=${s.cwd}` : "";
    process.stdout.write(
      `- **${short}**  ${when}  ${sizeKb}KB  ${s.userMsgCount}u/${s.assistantCount}a${cwd}\n`,
    );
    process.stdout.write(`  "${msg}"\n`);
  }
}

// ------------- summarization -------------

export type UserMsg = { ts: string; text: string };
export type AssistantTurn = { ts: string; text: string; toolUses: ToolUseRef[] };
export type ToolUseRef = { name: string; brief: string };
export type ErrorHit = { ts: string; tool: string; error: string };

export async function summarizeSession(file: string): Promise<string> {
  const raw = await readOrEmpty(file);
  const lines = raw.split("\n").filter(Boolean);

  const userMsgs: UserMsg[] = [];
  const assistantTurns: AssistantTurn[] = [];
  const errors: ErrorHit[] = [];
  const toolCounts: Record<string, number> = {};
  const filesTouched = new Set<string>();
  const bashCommands: string[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let cwd: string | null = null;
  let sessionId: string | null = null;

  // map tool_use_id → tool name, to resolve tool_result errors back to the tool
  const toolUseById = new Map<string, string>();

  for (const line of lines) {
    let e: AnyEvent;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.timestamp) {
      if (!firstTs) firstTs = e.timestamp;
      lastTs = e.timestamp;
    }
    if (e.cwd && !cwd) cwd = e.cwd;
    if (e.sessionId && !sessionId) sessionId = e.sessionId;

    if (e.type === "user") {
      const content = e.message?.content;
      if (typeof content === "string") {
        userMsgs.push({ ts: e.timestamp, text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "tool_result" && part.is_error) {
            const toolName = toolUseById.get(part.tool_use_id) ?? "unknown";
            const errText = stringifyContent(part.content).slice(0, 300);
            errors.push({ ts: e.timestamp, tool: toolName, error: errText });
          }
        }
      }
    }

    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      const turn: AssistantTurn = { ts: e.timestamp, text: "", toolUses: [] };
      for (const part of e.message.content) {
        if (part.type === "text") {
          turn.text += (turn.text ? "\n\n" : "") + String(part.text ?? "");
        } else if (part.type === "tool_use") {
          const name = part.name ?? "unknown";
          toolUseById.set(part.id, name);
          toolCounts[name] = (toolCounts[name] ?? 0) + 1;
          turn.toolUses.push({ name, brief: briefToolInput(name, part.input) });
          collectToolMeta(name, part.input, filesTouched, bashCommands);
        }
        // 'thinking' parts are intentionally skipped — internal only
      }
      assistantTurns.push(turn);
    }
  }

  return renderMarkdown({
    sourceLabel: "Claude Code",
    sessionId,
    file,
    cwd,
    firstTs,
    lastTs,
    userMsgs,
    assistantTurns,
    errors,
    toolCounts,
    filesTouched,
    bashCommands,
  });
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? (p as any).text : JSON.stringify(p)))
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function briefToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return String(input.command ?? "").slice(0, 100);
  if (name === "Read" || name === "Write" || name === "Edit") return String(input.file_path ?? "");
  if (name === "Glob") return String(input.pattern ?? "");
  if (name === "Grep") return String(input.pattern ?? "");
  return JSON.stringify(input).slice(0, 100);
}

function collectToolMeta(
  name: string,
  input: any,
  filesTouched: Set<string>,
  bashCommands: string[],
): void {
  if (!input || typeof input !== "object") return;
  if (name === "Write" || name === "Edit") {
    if (input.file_path) filesTouched.add(String(input.file_path));
  }
  if (name === "Bash" && typeof input.command === "string") {
    bashCommands.push(input.command);
  }
}

// ------------- rendering -------------

export type RenderCtx = {
  /** Human-readable source tool label (e.g. "Claude Code", "Cursor"). */
  sourceLabel: string;
  sessionId: string | null;
  /** Human-readable locator for the session's source (file path, db:id, etc.). */
  file: string;
  cwd: string | null;
  firstTs: string | null;
  lastTs: string | null;
  userMsgs: UserMsg[];
  assistantTurns: AssistantTurn[];
  errors: ErrorHit[];
  toolCounts: Record<string, number>;
  filesTouched: Set<string>;
  bashCommands: string[];
};

export function renderMarkdown(ctx: RenderCtx): string {
  const out: string[] = [];
  const short = ctx.sessionId ? ctx.sessionId.slice(0, 8) : "unknown";
  const duration = humanDuration(ctx.firstTs, ctx.lastTs);

  out.push(`# ${ctx.sourceLabel} Session: ${short}`);
  out.push("");
  out.push(`- **Session ID**: \`${ctx.sessionId ?? "?"}\``);
  out.push(`- **Project cwd**: \`${ctx.cwd ?? "?"}\``);
  out.push(`- **Started**: ${ctx.firstTs ?? "?"}`);
  out.push(`- **Ended**: ${ctx.lastTs ?? "?"}`);
  out.push(`- **Duration**: ${duration}`);
  out.push(`- **User messages**: ${ctx.userMsgs.length}`);
  out.push(`- **Assistant turns**: ${ctx.assistantTurns.length}`);
  out.push(`- **Source file**: \`${ctx.file}\``);
  out.push("");

  out.push("## User messages (chronological)");
  out.push("");
  if (ctx.userMsgs.length === 0) {
    out.push("_(none)_");
  } else {
    ctx.userMsgs.forEach((m, i) => {
      const hm = hhmm(m.ts);
      const firstLine = m.text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ⏎ ")
        .slice(0, 400);
      out.push(`${i + 1}. [${hm}] ${firstLine}`);
    });
  }
  out.push("");

  out.push("## Tool activity");
  out.push("");
  const toolEntries = Object.entries(ctx.toolCounts).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length === 0) {
    out.push("_(no tool calls)_");
  } else {
    for (const [name, n] of toolEntries) {
      out.push(`- ${name}: ${n}`);
    }
  }
  out.push("");

  if (ctx.filesTouched.size > 0) {
    out.push("### Files written/edited");
    out.push("");
    for (const f of [...ctx.filesTouched].sort()) {
      out.push(`- \`${f}\``);
    }
    out.push("");
  }

  if (ctx.bashCommands.length > 0) {
    out.push("### Bash commands (deduped, first 30)");
    out.push("");
    const unique = [...new Set(ctx.bashCommands.map((c) => c.trim()))].slice(0, 30);
    for (const c of unique) {
      out.push(`- \`${c.length > 120 ? c.slice(0, 117) + "..." : c}\``);
    }
    out.push("");
  }

  if (ctx.errors.length > 0) {
    out.push("## Errors hit");
    out.push("");
    ctx.errors.slice(0, 20).forEach((e, i) => {
      const hm = hhmm(e.ts);
      const first = e.error.split("\n")[0].slice(0, 200);
      out.push(`${i + 1}. [${hm}] **${e.tool}**: ${first}`);
    });
    if (ctx.errors.length > 20) out.push(`\n_(${ctx.errors.length - 20} more errors truncated)_`);
    out.push("");
  }

  out.push("## Assistant's final messages");
  out.push("");
  const final = ctx.assistantTurns
    .filter((t) => t.text.trim().length > 0)
    .slice(-3);
  if (final.length === 0) {
    out.push("_(none)_");
  } else {
    final.forEach((t, i) => {
      const hm = hhmm(t.ts);
      out.push(`### ${i + 1}. [${hm}]`);
      out.push("");
      out.push(t.text.length > 1500 ? t.text.slice(0, 1500) + "\n\n_(truncated)_" : t.text);
      out.push("");
    });
  }

  out.push("---");
  out.push("");
  out.push(
    "_Next step for the reading agent: use the above to populate `.handoff/task.md`, " +
      "`.handoff/progress.md`, `.handoff/decisions.md`, `.handoff/attempts.md`, and " +
      "`.handoff/corrections.md`. Only log entries that would help a future agent — " +
      "skip trivial tool calls._",
  );
  out.push("");

  return out.join("\n");
}

function hhmm(ts: string | null | undefined): string {
  if (!ts) return "?";
  try {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "?";
  }
}

export function humanDuration(a: string | null, b: string | null): string {
  if (!a || !b) return "?";
  try {
    const ms = new Date(b).getTime() - new Date(a).getTime();
    if (ms < 0) return "?";
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h${m}m`;
  } catch {
    return "?";
  }
}
