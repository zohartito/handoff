import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exists, readOrEmpty } from "../util/fs.js";
import {
  renderMarkdown,
  emitOutput,
  type AssistantTurn,
  type ErrorHit,
  type SessionSummary,
  type ToolUseRef,
  type UserMsg,
} from "../commands/ingest.js";

/**
 * Codex CLI adapter for `handoff ingest --from codex`.
 *
 * Codex stores each session as a JSONL "rollout" at:
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl
 * ($CODEX_HOME defaults to ~/.codex; on Windows C:\Users\<user>\.codex)
 *
 * A session_index.jsonl (`{id, thread_name, updated_at}` per line) gives a
 * cheap id→title map but omits `cwd`, so we still peek each file's first
 * `session_meta` line to scope sessions to a project path.
 *
 * Line shape: `{timestamp, type, payload}`. The interesting payloads are:
 *   - type=session_meta (first line; carries id, cwd, cli_version)
 *   - type=response_item / payload.type=message (role user|assistant|developer)
 *   - type=response_item / payload.type=function_call (+ matching
 *     function_call_output by call_id)
 *   - type=response_item / payload.type=reasoning (skipped — internal)
 *
 * Parser is tolerant of malformed trailing lines (the active rollout may be
 * partially written when we read it).
 */

export type CodexIngestOpts = {
  session?: string;
  list?: boolean;
  out?: string;
  project: string; // absolute project path
};

type AnyEvent = Record<string, any>;

type CodexRolloutInfo = {
  id: string;
  file: string;
  mtime: Date;
  size: number;
  cwd: string | null;
  cliVersion: string | null;
  threadName: string | null;
};

export async function ingestCodex(opts: CodexIngestOpts): Promise<void> {
  const codexHome = codexHomeDir();
  const sessionsRoot = join(codexHome, "sessions");
  if (!(await exists(sessionsRoot))) {
    console.error(
      `no Codex sessions dir found\n  expected: ${sessionsRoot}\n` +
        `(is the Codex CLI installed? honor $CODEX_HOME if non-default.)`,
    );
    process.exitCode = 1;
    return;
  }

  const indexPath = join(codexHome, "session_index.jsonl");
  const threadNames = await readSessionIndex(indexPath);
  const allRollouts = await listRolloutFiles(sessionsRoot);
  // Peek each rollout's session_meta once so we can filter by cwd.
  const withMeta: CodexRolloutInfo[] = [];
  for (const r of allRollouts) {
    const meta = await readSessionMeta(r.file);
    withMeta.push({
      id: meta?.id ?? idFromFilename(r.file) ?? "",
      file: r.file,
      mtime: r.mtime,
      size: r.size,
      cwd: meta?.cwd ?? null,
      cliVersion: meta?.cliVersion ?? null,
      threadName: meta?.id ? threadNames.get(meta.id) ?? null : null,
    });
  }

  const scoped = scopeByProject(withMeta, opts.project);
  if (scoped.length === 0) {
    console.error(
      `no Codex sessions found for ${opts.project}\n` +
        `  scanned ${sessionsRoot} (${withMeta.length} rollouts; none matched this path or its parents)`,
    );
    process.exitCode = 1;
    return;
  }

  if (opts.list) {
    const summaries: SessionSummary[] = [];
    for (const info of scoped) {
      const sum = await quickCodexSummary(info);
      if (sum) summaries.push(sum);
    }
    summaries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    printCodexSessionList(summaries, sessionsRoot);
    return;
  }

  const sessionId = opts.session ?? "latest";
  const resolved = resolveCodexRollout(scoped, sessionId);
  if (!resolved) {
    const ids = scoped
      .slice(0, 5)
      .map((r) => r.id.slice(0, 8))
      .join(", ");
    console.error(
      `session not found: ${sessionId}\n` +
        `  scanned: ${sessionsRoot}\n` +
        (ids ? `  available (most recent): ${ids}` : `  no sessions in any dir`),
    );
    process.exitCode = 1;
    return;
  }

  const output = await summarizeCodexSession(resolved.file);
  await emitOutput(output, opts.out);
}

// ------------- filesystem layout -------------

function codexHomeDir(): string {
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return join(homedir(), ".codex");
}

type BareRollout = { file: string; mtime: Date; size: number };

/**
 * Walk ~/.codex/sessions/YYYY/MM/DD for rollout-*.jsonl files, newest-first
 * by mtime. No depth limit beyond the fixed YYYY/MM/DD layout, so this stays
 * fast even on machines with thousands of sessions.
 */
async function listRolloutFiles(sessionsRoot: string): Promise<BareRollout[]> {
  const out: BareRollout[] = [];
  let years: string[];
  try {
    years = await fs.readdir(sessionsRoot);
  } catch {
    return out;
  }
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    const yDir = join(sessionsRoot, y);
    let months: string[] = [];
    try {
      months = await fs.readdir(yDir);
    } catch {
      continue;
    }
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      const mDir = join(yDir, m);
      let days: string[] = [];
      try {
        days = await fs.readdir(mDir);
      } catch {
        continue;
      }
      for (const d of days) {
        if (!/^\d{2}$/.test(d)) continue;
        const dDir = join(mDir, d);
        let files: string[] = [];
        try {
          files = await fs.readdir(dDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          const full = join(dDir, f);
          try {
            const stat = await fs.stat(full);
            out.push({ file: full, mtime: stat.mtime, size: stat.size });
          } catch {
            // skip unreadable file
          }
        }
      }
    }
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

/** rollout-2026-04-15T16-38-07-<uuid>.jsonl → <uuid> (last uuid-shaped segment) */
function idFromFilename(file: string): string | null {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] ?? null;
}

type SessionMeta = { id: string | null; cwd: string | null; cliVersion: string | null };

/**
 * Read and parse the first line of a rollout — expected to be session_meta.
 * Returns null if the file is missing/empty/malformed; the rollout may be
 * mid-write so we stay tolerant.
 */
async function readSessionMeta(file: string): Promise<SessionMeta | null> {
  const raw = await readOrEmpty(file);
  if (!raw) return null;
  const firstLine = raw.split(/\r?\n/, 1)[0];
  if (!firstLine) return null;
  let parsed: AnyEvent;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (parsed?.type !== "session_meta") return null;
  const payload = parsed.payload ?? {};
  return {
    id: typeof payload.id === "string" ? payload.id : null,
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : null,
  };
}

async function readSessionIndex(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const raw = await readOrEmpty(path);
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.id && typeof rec.id === "string" && typeof rec.thread_name === "string") {
        out.set(rec.id, rec.thread_name);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Scope rollouts to a project path by matching `session_meta.payload.cwd`
 * against the project path or any of its parents (walk up 8 levels, same as
 * the Claude Code adapter). Windows path handling: lowercase drive letter
 * and normalize to forward slashes so backslash/slash variants match.
 */
function scopeByProject(rollouts: CodexRolloutInfo[], projectPath: string): CodexRolloutInfo[] {
  const targets = new Set<string>();
  let p = resolve(projectPath);
  for (let i = 0; i < 8; i++) {
    targets.add(normalizePath(p));
    const parent = p.replace(/[\\/][^\\/]+$/, "");
    if (!parent || parent === p) break;
    p = parent;
  }
  return rollouts.filter((r) => r.cwd && targets.has(normalizePath(r.cwd)));
}

function normalizePath(p: string): string {
  // Windows: lowercase drive letter, forward slashes, strip trailing slash.
  let n = p.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(n)) n = n[0].toLowerCase() + n.slice(1);
  if (n.length > 3 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}

// ------------- session resolution / listing -------------

function resolveCodexRollout(
  rollouts: CodexRolloutInfo[],
  sessionId: string,
): CodexRolloutInfo | null {
  if (sessionId === "latest") {
    const sorted = [...rollouts].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return sorted[0] ?? null;
  }
  // Exact id match, then short-prefix match.
  const exact = rollouts.find((r) => r.id === sessionId);
  if (exact) return exact;
  const prefix = rollouts.find((r) => r.id.startsWith(sessionId));
  return prefix ?? null;
}

async function quickCodexSummary(info: CodexRolloutInfo): Promise<SessionSummary | null> {
  const raw = await readOrEmpty(info.file);
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).filter(Boolean);

  let userMsgCount = 0;
  let assistantCount = 0;
  let firstUserMsg: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  for (const line of lines) {
    let e: AnyEvent;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.timestamp === "string") {
      if (!firstTs) firstTs = e.timestamp;
      lastTs = e.timestamp;
    }
    if (e.type !== "response_item") continue;
    const payload = e.payload ?? {};
    if (payload.type !== "message") continue;
    if (payload.role === "user") {
      // Skip synthetic environment_context user messages (wrapper adds them)
      const text = collectInputText(payload.content);
      if (!text || /^<(environment_context|permissions instructions|app-context|collaboration_mode|apps_instructions|skills_instructions|plugins_instructions)/.test(text.trim())) {
        continue;
      }
      userMsgCount++;
      if (!firstUserMsg) firstUserMsg = text.trim().slice(0, 120);
    } else if (payload.role === "assistant") {
      assistantCount++;
    }
  }

  return {
    id: info.id,
    file: info.file,
    size: info.size,
    mtime: info.mtime,
    firstUserMsg: firstUserMsg ?? info.threadName,
    firstTs,
    lastTs,
    userMsgCount,
    assistantCount,
    cwd: info.cwd,
  };
}

function printCodexSessionList(sessions: SessionSummary[], sessionsRoot: string): void {
  process.stdout.write(`# Codex sessions\n\n`);
  process.stdout.write(`Scanned: ${sessionsRoot}\n\n`);
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

// ------------- tool normalization -------------

/**
 * Normalize Codex's function_call.name values into the same PascalCase
 * vocabulary Claude Code uses. Mirrors CURSOR_TOOL_MAP so downstream tooling
 * (counts, files-touched detection) can be source-agnostic.
 *
 * Note: we map both `write_file` and `apply_patch` to "Edit" — Codex uses
 * apply_patch as its primary file-editor; treating both as edits keeps the
 * filesTouched set and downstream prose consistent.
 */
export const CODEX_TOOL_MAP: Record<string, string> = {
  read_file: "Read",
  write_file: "Edit",
  apply_patch: "Edit",
  shell: "Bash",
  shell_command: "Bash",
  exec_command: "Bash",
  search: "Grep",
  grep: "Grep",
  glob: "Glob",
  update_plan: "TodoWrite",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

export function normalizeCodexToolName(name: string | undefined): string {
  if (!name) return "Unknown";
  return CODEX_TOOL_MAP[name] ?? name;
}

// ------------- summarization -------------

export async function summarizeCodexSession(file: string): Promise<string> {
  const raw = await readOrEmpty(file);
  const lines = raw.split(/\r?\n/).filter(Boolean);

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

  // Pair function_call → function_call_output by call_id so error detection
  // can report against the tool that actually made the call.
  const toolByCallId = new Map<string, string>();

  // Assistant response_items arrive as individual messages; Codex can emit
  // multiple consecutive ones between user turns. We merge contiguous ones
  // into a single AssistantTurn (matches Cursor's shape).
  let currentTurn: AssistantTurn | null = null;
  const closeTurn = () => {
    if (currentTurn) {
      assistantTurns.push(currentTurn);
      currentTurn = null;
    }
  };

  for (const line of lines) {
    let e: AnyEvent;
    try {
      e = JSON.parse(line);
    } catch {
      // Tolerate malformed lines — rollouts may be mid-write.
      continue;
    }
    const ts = typeof e.timestamp === "string" ? e.timestamp : "";
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    if (e.type === "session_meta") {
      const payload = e.payload ?? {};
      if (typeof payload.id === "string" && !sessionId) sessionId = payload.id;
      if (typeof payload.cwd === "string" && !cwd) cwd = payload.cwd;
      continue;
    }

    if (e.type !== "response_item") continue;
    const payload = e.payload ?? {};

    if (payload.type === "message") {
      if (payload.role === "user") {
        const text = collectInputText(payload.content);
        if (!text) continue;
        // Skip synthetic wrapper messages (environment_context, app-context, etc.)
        if (isSyntheticUserMessage(text)) continue;
        closeTurn();
        userMsgs.push({ ts, text });
      } else if (payload.role === "assistant") {
        const text = collectOutputText(payload.content);
        if (!currentTurn) currentTurn = { ts, text: "", toolUses: [] };
        if (text && text.trim().length > 0) {
          currentTurn.text += (currentTurn.text ? "\n\n" : "") + text;
        }
      }
      // developer/system messages are internal framing — skip
      continue;
    }

    if (payload.type === "reasoning") {
      // Internal thinking — intentionally skipped (parity with Claude Code).
      continue;
    }

    if (payload.type === "function_call") {
      const rawName = typeof payload.name === "string" ? payload.name : undefined;
      const toolName = normalizeCodexToolName(rawName);
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      const parsed = safeParse(payload.arguments);
      if (!currentTurn) currentTurn = { ts, text: "", toolUses: [] };
      const brief = briefCodexToolInput(toolName, parsed);
      currentTurn.toolUses.push({ name: toolName, brief });
      if (typeof payload.call_id === "string") {
        toolByCallId.set(payload.call_id, toolName);
      }
      collectCodexToolMeta(toolName, parsed, filesTouched, bashCommands);
      continue;
    }

    if (payload.type === "function_call_output") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      const toolName = toolByCallId.get(callId) ?? "Unknown";
      const err = detectCodexError(payload.output);
      if (err) errors.push({ ts, tool: toolName, error: err });
      continue;
    }

    // Bucket misc tool-ish event types (custom_tool_call, web_search_call, etc.)
    // under their own counts so the activity summary stays complete.
    if (
      payload.type === "custom_tool_call" ||
      payload.type === "web_search_call" ||
      payload.type === "exec_command_end" ||
      payload.type === "patch_apply_end"
    ) {
      toolCounts[payload.type] = (toolCounts[payload.type] ?? 0) + 1;
      continue;
    }
  }
  closeTurn();

  return renderMarkdown({
    sourceLabel: "Codex",
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

function collectInputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      const part = c as AnyEvent;
      if (part.type === "input_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

function collectOutputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      const part = c as AnyEvent;
      if (part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

/**
 * Codex injects wrapper "user" messages with angle-bracketed tags
 * (<environment_context>, <permissions instructions>, etc.) on every
 * turn. These aren't actual user input — skip them so counts reflect
 * real conversation.
 */
function isSyntheticUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return /^<(environment_context|permissions instructions|app-context|collaboration_mode|apps_instructions|skills_instructions|plugins_instructions)\b/.test(
    trimmed,
  );
}

function safeParse(s: unknown): any | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function briefCodexToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return String(input.command ?? "").slice(0, 100);
  if (name === "Read") return String(input.path ?? input.file_path ?? input.target ?? "");
  if (name === "Edit") {
    // apply_patch carries a `patch` or `input` string; write_file uses `path`.
    return String(
      input.path ?? input.file_path ?? input.target ?? "",
    );
  }
  if (name === "Glob") return String(input.pattern ?? input.glob ?? "");
  if (name === "Grep") return String(input.pattern ?? input.query ?? "");
  if (name === "WebSearch") return String(input.query ?? "");
  if (name === "WebFetch") return String(input.url ?? "");
  if (name === "TodoWrite") {
    // update_plan carries { explanation, plan: [{step, status}] } — brief to step count.
    const steps = Array.isArray(input.plan) ? input.plan.length : 0;
    return steps > 0 ? `${steps} steps` : String(input.explanation ?? "").slice(0, 100);
  }
  return JSON.stringify(input).slice(0, 100);
}

function collectCodexToolMeta(
  name: string,
  input: any,
  filesTouched: Set<string>,
  bashCommands: string[],
): void {
  if (!input || typeof input !== "object") return;
  if (name === "Edit") {
    const candidate = input.path ?? input.file_path ?? input.target;
    if (candidate) filesTouched.add(String(candidate));
    // apply_patch bundles several paths inside the patch text; best-effort
    // extract `*** Update File: <path>` and `*** Add File: <path>` markers.
    if (typeof input.input === "string" || typeof input.patch === "string") {
      const body = String(input.input ?? input.patch ?? "");
      for (const m of body.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) {
        filesTouched.add(m[1].trim());
      }
    }
  }
  if (name === "Bash" && typeof input.command === "string") {
    bashCommands.push(input.command);
  }
}

/**
 * Decide whether a function_call_output is an error. Codex's shell tool
 * writes `Exit code: <n>\n...` as a plain string; other tools sometimes
 * wrap structured JSON. Recognize the common shapes.
 */
function detectCodexError(output: unknown): string | null {
  if (output == null) return null;
  if (typeof output === "string") {
    const s = output;
    const m = s.match(/^Exit code:\s*(-?\d+)/i);
    if (m && m[1] !== "0") {
      const firstLine = s.split("\n").find((l) => l.trim().length > 0) ?? s;
      return firstLine.slice(0, 300);
    }
    // Bare "Error:" lines
    if (/^error[: ]/i.test(s.trimStart())) return s.split("\n")[0].slice(0, 300);
    return null;
  }
  if (typeof output === "object") {
    const obj = output as AnyEvent;
    if (obj.is_error === true) {
      const msg = typeof obj.error === "string" ? obj.error : JSON.stringify(obj);
      return msg.slice(0, 300);
    }
    if (typeof obj.error === "string" && obj.error.trim().length > 0) {
      return obj.error.slice(0, 300);
    }
    if (typeof obj.exit_code === "number" && obj.exit_code !== 0) {
      const out = String(obj.output ?? obj.stderr ?? "").split("\n")[0];
      return `exit ${obj.exit_code}: ${out}`.slice(0, 300);
    }
  }
  return null;
}
