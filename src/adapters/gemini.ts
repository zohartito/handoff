import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { exists } from "../util/fs.js";
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
 * Gemini CLI adapter for `handoff ingest --from gemini`.
 *
 * Gemini CLI stores chat history as JSON arrays (and, post #15292, JSONL)
 * under `~/.gemini/tmp/<project_hash>/`. The mapping of project path →
 * project hash lives in `~/.gemini/projects.json`.
 *
 * Two kinds of files matter:
 *   - `chats/checkpoint-<tag>.json` — user-initiated `/chat save <tag>`
 *   - `checkpoints/<ts>-<filename>-<toolname>.json` — auto-saved before
 *     a file-writing tool runs
 *
 * Both share the Gemini API `Content` shape:
 *   [{role: "user"|"model", parts: [{text}|{functionCall}|{functionResponse}]}]
 *
 * CRITICAL: a `role: "user"` message whose parts contain a
 * `functionResponse` is a TOOL RESULT, not a real user message. These
 * must not inflate the user-message count.
 */

export type GeminiIngestOpts = {
  session?: string;
  list?: boolean;
  out?: string;
  project: string;
};

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: unknown } };

type GeminiMessage = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type Probe = {
  base: string;
  projectsJson: string;
};

export async function ingestGemini(opts: GeminiIngestOpts): Promise<void> {
  const probe = geminiPaths();
  if (!(await exists(probe.base))) {
    console.error(
      `no Gemini CLI data dir found\n  expected: ${probe.base}\n(is @google/gemini-cli installed for this user?)`,
    );
    process.exitCode = 1;
    return;
  }

  const mapping = await readProjectsJson(probe.projectsJson);
  const hash = await resolveProjectHash(mapping, opts.project, probe.base);
  if (!hash) {
    console.error(
      `no Gemini sessions for this project — Gemini requires \`/chat save <tag>\` to persist a chat. ` +
        `Run \`/chat save mytask\` in Gemini CLI first.\n` +
        `  project: ${opts.project}\n` +
        `  projects.json: ${probe.projectsJson}`,
    );
    process.exitCode = 1;
    return;
  }

  const sessionDir = join(probe.base, "tmp", hash);
  const chatsDir = join(sessionDir, "chats");
  const checkpointsDir = join(sessionDir, "checkpoints");

  if (opts.list) {
    const summaries = await listGeminiSessions(chatsDir, checkpointsDir);
    printGeminiSessionList(summaries, sessionDir);
    return;
  }

  const sessionId = opts.session ?? "latest";
  const resolved = await resolveGeminiSessionFile(chatsDir, checkpointsDir, sessionId);
  if (!resolved) {
    const summaries = await listGeminiSessions(chatsDir, checkpointsDir);
    const ids = summaries.slice(0, 5).map((s) => s.id.slice(0, 24)).join(", ");
    console.error(
      `session not found: ${sessionId}\n` +
        `  scanned: ${chatsDir}, ${checkpointsDir}\n` +
        (ids ? `  available (most recent): ${ids}` : `  no saved chats — run \`/chat save <tag>\` in Gemini CLI first`),
    );
    process.exitCode = 1;
    return;
  }

  const cwd = await readProjectRoot(sessionDir);
  const messages = await loadGeminiChatFile(resolved);
  if (messages === null) {
    console.error(`failed to parse Gemini chat file: ${resolved}`);
    process.exitCode = 1;
    return;
  }
  const output = summarizeGeminiChat(resolved, messages, cwd);
  await emitOutput(output, opts.out);
}

// ------------- filesystem layout -------------

function geminiPaths(): Probe {
  const base = join(homedir(), ".gemini");
  return {
    base,
    projectsJson: join(base, "projects.json"),
  };
}

type ProjectsJson = { projects?: Record<string, string> };

async function readProjectsJson(path: string): Promise<Record<string, string>> {
  if (!(await exists(path))) return {};
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ProjectsJson;
    return parsed.projects ?? {};
  } catch {
    return {};
  }
}

/**
 * `projects.json` keys are absolute paths normalized to forward slashes and,
 * on Windows, fully lowercased (Gemini lowercases the whole path, not just
 * the drive letter — observed key on this machine is `c:\\users\\zohar_4ta16fp`,
 * note lowercase `users`). We apply the same normalization to the path
 * we're looking up so the comparison is sound on a case-insensitive FS.
 */
function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/");
  if (n.length > 3 && n.endsWith("/")) n = n.slice(0, -1);
  if (process.platform === "win32") n = n.toLowerCase();
  else if (/^[a-zA-Z]:/.test(n)) n = n[0].toLowerCase() + n.slice(1);
  return n;
}

/**
 * Build a normalized-key view of projects.json. Gemini on Windows stores keys
 * with backslashes like `c:\\users\\zohar_4ta16fp`; normalize those to
 * forward-slashes to match the project path we're comparing against.
 */
function normalizedProjectMap(raw: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    out.set(normalizePath(k), v);
  }
  return out;
}

/**
 * Walk up to 8 parent dirs looking for a matching hash in projects.json.
 * Same contract as Claude Code + Cursor adapters — tolerant to the user
 * having launched Gemini from the project's parent dir.
 */
async function resolveProjectHash(
  mapping: Record<string, string>,
  projectPath: string,
  _base: string,
): Promise<string | null> {
  const normalizedMap = normalizedProjectMap(mapping);
  let p = resolve(projectPath);
  for (let i = 0; i < 8; i++) {
    const key = normalizePath(p);
    const hit = normalizedMap.get(key);
    if (hit) return hit;
    const parent = p.replace(/[\\/][^\\/]+$/, "");
    if (!parent || parent === p) break;
    p = parent;
  }
  return null;
}

/**
 * `~/.gemini/tmp/<hash>/.project_root` holds the absolute cwd of the project
 * that owns this session dir. Used only for cross-verification / display.
 */
async function readProjectRoot(sessionDir: string): Promise<string | null> {
  const f = join(sessionDir, ".project_root");
  if (!(await exists(f))) return null;
  try {
    const raw = await fs.readFile(f, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// ------------- session discovery -------------

type GeminiFileRef = { id: string; file: string; kind: "chat" | "checkpoint" | "jsonl" };

async function listJsonFiles(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith(".json") || e.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

async function collectSessionFiles(chatsDir: string, checkpointsDir: string): Promise<GeminiFileRef[]> {
  const out: GeminiFileRef[] = [];
  for (const f of await listJsonFiles(chatsDir)) {
    const id = f.replace(/\.jsonl?$/, "");
    const kind: GeminiFileRef["kind"] = f.endsWith(".jsonl") ? "jsonl" : "chat";
    out.push({ id, file: join(chatsDir, f), kind });
  }
  for (const f of await listJsonFiles(checkpointsDir)) {
    const id = f.replace(/\.jsonl?$/, "");
    const kind: GeminiFileRef["kind"] = f.endsWith(".jsonl") ? "jsonl" : "checkpoint";
    out.push({ id, file: join(checkpointsDir, f), kind });
  }
  return out;
}

export async function listGeminiSessions(
  chatsDir: string,
  checkpointsDir: string,
): Promise<SessionSummary[]> {
  const refs = await collectSessionFiles(chatsDir, checkpointsDir);
  const out: SessionSummary[] = [];
  for (const ref of refs) {
    try {
      const stat = await fs.stat(ref.file);
      const messages = await loadGeminiChatFile(ref.file);
      if (messages === null) continue;
      const quick = quickSummarizeGemini(messages);
      out.push({
        id: ref.id,
        file: ref.file,
        size: stat.size,
        mtime: stat.mtime,
        firstUserMsg: quick.firstUserMsg,
        firstTs: quick.firstTs,
        lastTs: quick.lastTs,
        userMsgCount: quick.userMsgCount,
        assistantCount: quick.assistantCount,
        cwd: null,
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

async function resolveGeminiSessionFile(
  chatsDir: string,
  checkpointsDir: string,
  sessionId: string,
): Promise<string | null> {
  const refs = await collectSessionFiles(chatsDir, checkpointsDir);
  if (refs.length === 0) return null;

  if (sessionId === "latest") {
    const summaries = await listGeminiSessions(chatsDir, checkpointsDir);
    return summaries[0]?.file ?? null;
  }

  // Exact basename (with or without extension)
  const exact = refs.find(
    (r) =>
      r.id === sessionId ||
      basename(r.file) === sessionId ||
      r.id === sessionId.replace(/\.jsonl?$/, ""),
  );
  if (exact) return exact.file;

  // Prefix match on id
  const prefix = refs.find((r) => r.id.startsWith(sessionId));
  if (prefix) return prefix.file;

  return null;
}

/**
 * Load a Gemini chat file — JSON array of `{role, parts}` messages.
 *
 * If the file ends with `.jsonl`, attempt to translate the post-#15292
 * record types into the same `GeminiMessage[]` shape. On any parse error
 * we log a stderr warning and return an empty array so discovery/listing
 * can continue without crashing.
 */
async function loadGeminiChatFile(file: string): Promise<GeminiMessage[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  if (file.endsWith(".jsonl")) {
    return loadGeminiJsonl(file, raw);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as GeminiMessage[];
  } catch {
    return null;
  }
}

type JsonlRecord =
  | { type: "user"; text?: string; timestamp?: string }
  | { type: "gemini"; text?: string; timestamp?: string }
  | { type: "message_update"; text?: string; timestamp?: string }
  | {
      type: "session_metadata";
      sessionId?: string;
      startTime?: string;
      displayName?: string;
    }
  | { type: string; [k: string]: unknown };

/**
 * Translate JSONL records to the internal `GeminiMessage[]` shape. This is
 * best-effort forward compatibility for issue #15292; text-only records
 * translate cleanly, richer tool-call records aren't documented yet so
 * they're skipped.
 */
function loadGeminiJsonl(file: string, raw: string): GeminiMessage[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: GeminiMessage[] = [];
  for (const line of lines) {
    let rec: JsonlRecord;
    try {
      rec = JSON.parse(line) as JsonlRecord;
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || !("type" in rec)) continue;
    if (rec.type === "user" && typeof (rec as any).text === "string") {
      out.push({ role: "user", parts: [{ text: String((rec as any).text) }] });
    } else if (rec.type === "gemini" && typeof (rec as any).text === "string") {
      out.push({ role: "model", parts: [{ text: String((rec as any).text) }] });
    } else if (rec.type === "message_update" && typeof (rec as any).text === "string") {
      // treat updates as model continuations
      out.push({ role: "model", parts: [{ text: String((rec as any).text) }] });
    }
    // session_metadata + unknown types silently skipped
  }
  if (lines.length > 0 && out.length === 0) {
    process.stderr.write(
      `handoff: Gemini JSONL file had no translatable records, skipping: ${file}\n`,
    );
  }
  return out;
}

type QuickSummary = {
  firstUserMsg: string | null;
  firstTs: string | null;
  lastTs: string | null;
  userMsgCount: number;
  assistantCount: number;
};

/**
 * Fast pre-pass for listing: counts real user messages (excluding
 * functionResponse tool results) and collapses consecutive `model` messages
 * into one assistant turn — same rule as the full summarizer.
 */
function quickSummarizeGemini(messages: GeminiMessage[]): QuickSummary {
  let firstUserMsg: string | null = null;
  let userMsgCount = 0;
  let assistantCount = 0;
  let prevRole: "user" | "model" | null = null;
  for (const msg of messages) {
    if (msg.role === "user") {
      if (isRealUserMessage(msg)) {
        userMsgCount++;
        if (!firstUserMsg) {
          const text = extractUserText(msg);
          if (text) firstUserMsg = text.trim().slice(0, 120);
        }
        prevRole = "user";
      } else {
        // tool result — doesn't change prevRole in terms of turn boundaries,
        // but break any model-run because the next model message is a
        // response to the tool result.
        prevRole = "user";
      }
    } else if (msg.role === "model") {
      if (prevRole !== "model") assistantCount++;
      prevRole = "model";
    }
  }
  return {
    firstUserMsg,
    firstTs: null, // chat JSON has no per-message ts; checkpoint filename can carry one
    lastTs: null,
    userMsgCount,
    assistantCount,
  };
}

// ------------- summarization -------------

/**
 * Gemini's built-in tool vocabulary, normalized to the same PascalCase names
 * Claude Code uses so downstream tooling/templates stay uniform.
 */
export const GEMINI_TOOL_MAP: Record<string, string> = {
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  edit_file: "Edit",
  run_shell_command: "Bash",
  glob_files: "Glob",
  list_directory: "Glob",
  grep_files: "Grep",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

export function normalizeGeminiToolName(name: string | undefined): string {
  if (!name) return "Unknown";
  return GEMINI_TOOL_MAP[name] ?? name;
}

/**
 * True iff this `role: "user"` message is a real user message and NOT a
 * tool result (`functionResponse`). Critical for correct user-message
 * counting.
 */
function isRealUserMessage(msg: GeminiMessage): boolean {
  if (msg.role !== "user") return false;
  const parts = msg.parts ?? [];
  if (parts.length === 0) return false;
  for (const p of parts) {
    if (p && typeof p === "object" && "functionResponse" in p) return false;
  }
  return parts.some((p) => p && typeof p === "object" && "text" in p && typeof (p as any).text === "string");
}

function extractUserText(msg: GeminiMessage): string {
  return (msg.parts ?? [])
    .map((p) =>
      p && typeof p === "object" && "text" in p && typeof (p as any).text === "string"
        ? (p as any).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function extractModelText(msg: GeminiMessage): string {
  return (msg.parts ?? [])
    .map((p) =>
      p && typeof p === "object" && "text" in p && typeof (p as any).text === "string"
        ? (p as any).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

type FunctionCallPart = { functionCall: { name: string; args?: Record<string, unknown> } };
type FunctionResponsePart = { functionResponse: { name: string; response: unknown } };

function extractFunctionCalls(msg: GeminiMessage): FunctionCallPart["functionCall"][] {
  return (msg.parts ?? [])
    .filter((p): p is FunctionCallPart => !!p && typeof p === "object" && "functionCall" in p)
    .map((p) => p.functionCall);
}

function extractFunctionResponses(msg: GeminiMessage): FunctionResponsePart["functionResponse"][] {
  return (msg.parts ?? [])
    .filter((p): p is FunctionResponsePart => !!p && typeof p === "object" && "functionResponse" in p)
    .map((p) => p.functionResponse);
}

/**
 * Render a Gemini chat JSON array into the shared markdown summary format.
 *
 * Rules:
 * - `role: "user"` with any text part → real user message
 * - `role: "user"` with ONLY functionResponse parts → tool result, not a msg
 * - Consecutive `role: "model"` messages collapse into one AssistantTurn
 *   (each functionCall in the run becomes its own toolUse)
 * - functionResponse containing `error` or non-zero `exit_code` → ErrorHit
 */
export function summarizeGeminiChat(
  file: string,
  chatJson: any[],
  cwd: string | null,
): string {
  const userMsgs: UserMsg[] = [];
  const assistantTurns: AssistantTurn[] = [];
  const errors: ErrorHit[] = [];
  const toolCounts: Record<string, number> = {};
  const filesTouched = new Set<string>();
  const bashCommands: string[] = [];

  let currentTurn: AssistantTurn | null = null;
  const closeTurn = () => {
    if (currentTurn) {
      assistantTurns.push(currentTurn);
      currentTurn = null;
    }
  };

  // Gemini chat JSON has no per-message timestamps. The whole file
  // represents one session — we use empty strings downstream; the render
  // layer tolerates `ts: ""` correctly (it just prints `?`).
  const ts = "";

  for (const msg of chatJson ?? []) {
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "user") {
      const fnResponses = extractFunctionResponses(msg);
      if (fnResponses.length > 0) {
        // tool result — does not start a new user message, but closes any
        // current assistant turn (the model's next message is a NEW turn
        // responding to the tool result)
        for (const fr of fnResponses) {
          const err = detectFunctionResponseError(fr.response);
          if (err) {
            errors.push({
              ts,
              tool: normalizeGeminiToolName(fr.name),
              error: err,
            });
          }
        }
        closeTurn();
        continue;
      }
      if (isRealUserMessage(msg)) {
        closeTurn();
        userMsgs.push({ ts, text: extractUserText(msg) });
      }
      continue;
    }

    if (msg.role === "model") {
      if (!currentTurn) currentTurn = { ts, text: "", toolUses: [] };
      const modelText = extractModelText(msg);
      if (modelText.trim().length > 0) {
        currentTurn.text += (currentTurn.text ? "\n\n" : "") + modelText;
      }
      for (const fc of extractFunctionCalls(msg)) {
        const toolName = normalizeGeminiToolName(fc.name);
        toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
        currentTurn.toolUses.push({
          name: toolName,
          brief: briefGeminiToolInput(toolName, fc.args ?? {}),
        });
        collectGeminiToolMeta(toolName, fc.args ?? {}, filesTouched, bashCommands);
      }
    }
  }
  closeTurn();

  // Best-effort session id: strip "checkpoint-" prefix if present
  const sessionId = basename(file).replace(/\.jsonl?$/, "").replace(/^checkpoint-/, "");

  return renderMarkdown({
    sourceLabel: "Gemini",
    sessionId,
    file,
    cwd,
    firstTs: null,
    lastTs: null,
    userMsgs,
    assistantTurns,
    errors,
    toolCounts,
    filesTouched,
    bashCommands,
  });
}

function briefGeminiToolInput(name: string, input: Record<string, unknown>): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return String(input.command ?? "").slice(0, 100);
  if (name === "Read")
    return String(input.absolute_path ?? input.path ?? input.file_path ?? input.paths ?? "");
  if (name === "Write")
    return String(input.file_path ?? input.path ?? input.absolute_path ?? "");
  if (name === "Edit")
    return String(input.file_path ?? input.path ?? input.absolute_path ?? "");
  if (name === "Glob")
    return String(input.pattern ?? input.path ?? input.directory ?? "");
  if (name === "Grep")
    return String(input.pattern ?? "");
  if (name === "WebSearch") return String(input.query ?? "");
  if (name === "WebFetch") return String(input.url ?? input.prompt ?? "");
  return JSON.stringify(input).slice(0, 100);
}

function collectGeminiToolMeta(
  name: string,
  input: Record<string, unknown>,
  filesTouched: Set<string>,
  bashCommands: string[],
): void {
  if (!input || typeof input !== "object") return;
  if (name === "Edit" || name === "Write") {
    const p = input.file_path ?? input.path ?? input.absolute_path;
    if (p) filesTouched.add(String(p));
  }
  if (name === "Bash" && typeof input.command === "string") {
    bashCommands.push(input.command);
  }
}

/**
 * functionResponse payloads vary by tool, but the community convention is
 * either an `error` field (string) or an execution envelope containing
 * `exit_code` / `exitCode` (shell tool). We detect both.
 */
function detectFunctionResponseError(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  if (typeof r.error === "string" && r.error.trim().length > 0) {
    return r.error.slice(0, 300);
  }
  const nestedErr = (r.response as Record<string, unknown> | undefined)?.error;
  if (typeof nestedErr === "string" && nestedErr.trim().length > 0) {
    return nestedErr.slice(0, 300);
  }
  const exitCode = r.exit_code ?? r.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) {
    const out = String(r.output ?? r.stderr ?? r.stdout ?? "").split("\n")[0];
    return `exit ${exitCode}: ${out}`.slice(0, 300);
  }
  return null;
}

function printGeminiSessionList(sessions: SessionSummary[], sessionDir: string): void {
  process.stdout.write(`# Gemini sessions\n\n`);
  process.stdout.write(`Scanned: ${sessionDir}\n\n`);
  if (sessions.length === 0) {
    process.stdout.write(
      "(no saved chats — Gemini only persists conversations after `/chat save <tag>` " +
        "or when a file-writing tool triggers an auto-checkpoint.)\n",
    );
    return;
  }
  for (const s of sessions) {
    const short = s.id.length > 24 ? s.id.slice(0, 24) + "…" : s.id;
    const when = s.mtime.toISOString().replace("T", " ").slice(0, 16);
    const sizeKb = Math.round(s.size / 1024);
    const msg = s.firstUserMsg ? s.firstUserMsg.replace(/\s+/g, " ") : "(no user msg)";
    process.stdout.write(
      `- **${short}**  ${when}  ${sizeKb}KB  ${s.userMsgCount}u/${s.assistantCount}a\n`,
    );
    process.stdout.write(`  "${msg}"\n`);
  }
}
