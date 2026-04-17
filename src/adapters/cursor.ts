import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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
 * Cursor adapter for `handoff ingest --from cursor`.
 *
 * Cursor stores chat history ("composers") in two SQLite DBs:
 *   - Global:     ~/AppData/Roaming/Cursor/User/globalStorage/state.vscdb
 *                 cursorDiskKV: composerData:<uuid>, bubbleId:<composerId>:<bubbleId>
 *   - Per-workspace: ~/AppData/Roaming/Cursor/User/workspaceStorage/<hash>/state.vscdb
 *                    ItemTable: composer.composerData (selected/last-focused ids),
 *                               aiService.generations (recent generation log)
 *
 * Linking: there is no `workspaceId` on a composer. We infer workspace↔composer
 * links from:
 *   1. workspace.json `folder` URI (== project path)
 *   2. `composer.composerData.selectedComposerIds` + `lastFocusedComposerIds`
 *   3. `aiService.generations[*].composerId`
 *
 * The global DB holds the actual conversation content.
 */

export type CursorIngestOpts = {
  session?: string;
  list?: boolean;
  out?: string;
  project: string; // absolute project path
};

type Probe = { globalDb: string; workspaceRoot: string };

export async function ingestCursor(opts: CursorIngestOpts): Promise<void> {
  const probe = cursorPaths();
  if (!(await exists(probe.globalDb))) {
    console.error(
      `no Cursor state DB found\n  expected: ${probe.globalDb}\n(is Cursor installed for this user?)`,
    );
    process.exitCode = 1;
    return;
  }

  const workspaces = await findCursorWorkspaces(probe, opts.project);
  if (workspaces.length === 0) {
    console.error(
      `no Cursor workspace found for ${opts.project}\n` +
        `(scanned ${probe.workspaceRoot} for workspace.json matching this path or its parents)`,
    );
    process.exitCode = 1;
    return;
  }

  const globalDb = openReadOnly(probe.globalDb);
  try {
    if (opts.list) {
      const summaries = await listCursorSessions(globalDb, workspaces);
      printCursorSessionList(summaries, workspaces);
      return;
    }

    const sessionId = opts.session ?? "latest";
    const resolved = await resolveCursorSessionId(globalDb, workspaces, sessionId);
    if (!resolved) {
      const summaries = await listCursorSessions(globalDb, workspaces);
      const ids = summaries.slice(0, 5).map((s) => s.id.slice(0, 8)).join(", ");
      console.error(
        `session not found: ${sessionId}\n` +
          `  scanned workspaces: ${workspaces.map((w) => w.hash).join(", ")}\n` +
          (ids ? `  available (most recent): ${ids}` : `  no composers linked to these workspaces`),
      );
      process.exitCode = 1;
      return;
    }

    const cwd = resolved.workspace ? fileUriToPath(resolved.workspace.folderUri) : null;
    const output = summarizeCursorComposer(globalDb, resolved.id, probe.globalDb, cwd);
    await emitOutput(output, opts.out);
  } finally {
    globalDb.close();
  }
}

/**
 * Find the most-recent project-scoped Cursor composer for `project` and
 * return its rendered summary. Returns `null` when Cursor isn't installed,
 * no workspace matches this project, or no composer has been touched here.
 * Used by `handoff ingest --all`.
 */
export async function buildCursorSummary(opts: { project: string; session?: string }): Promise<string | null> {
  const probe = cursorPaths();
  if (!(await exists(probe.globalDb))) return null;
  const workspaces = await findCursorWorkspaces(probe, opts.project);
  if (workspaces.length === 0) return null;
  const globalDb = openReadOnly(probe.globalDb);
  try {
    const sessionId = opts.session ?? "latest";
    const resolved = await resolveCursorSessionId(globalDb, workspaces, sessionId);
    if (!resolved) return null;
    const cwd = resolved.workspace ? fileUriToPath(resolved.workspace.folderUri) : null;
    return summarizeCursorComposer(globalDb, resolved.id, probe.globalDb, cwd);
  } finally {
    globalDb.close();
  }
}

// ------------- filesystem layout -------------

/**
 * Cursor (Electron) stores its user data in the OS-standard per-user dir:
 *   - Windows: %APPDATA%\Cursor\User        (typically ~/AppData/Roaming)
 *   - macOS:   ~/Library/Application Support/Cursor/User
 *   - Linux:   $XDG_CONFIG_HOME/Cursor/User (default: ~/.config)
 * Only the Windows path has been end-to-end tested; mac/linux paths are the
 * Electron convention — not guaranteed to match Cursor's exact layout.
 */
function cursorPaths(): Probe {
  const base = join(cursorUserDir(), "User");
  return {
    globalDb: join(base, "globalStorage", "state.vscdb"),
    workspaceRoot: join(base, "workspaceStorage"),
  };
}

function cursorUserDir(): string {
  const plat = platform();
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Cursor");
  }
  if (plat === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor");
  }
  // linux (and other posix): respect XDG_CONFIG_HOME if set.
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "Cursor");
}

type CursorWorkspace = { hash: string; dir: string; folderUri: string; dbPath: string };

/**
 * Cursor folder URIs are `file:///c%3A/Users/...` (URL-encoded). We compare
 * against the project path by normalizing both sides to decoded absolute
 * paths with forward slashes lowercased on the drive letter.
 */
async function findCursorWorkspaces(probe: Probe, projectPath: string): Promise<CursorWorkspace[]> {
  if (!(await exists(probe.workspaceRoot))) return [];
  const entries = await fs.readdir(probe.workspaceRoot);
  const targets: Set<string> = new Set();
  let p = resolve(projectPath);
  for (let i = 0; i < 8; i++) {
    targets.add(normalizePath(p));
    const parent = p.replace(/[\\/][^\\/]+$/, "");
    if (!parent || parent === p) break;
    p = parent;
  }

  const matches: CursorWorkspace[] = [];
  for (const e of entries) {
    if (e === "empty-window") continue;
    const dir = join(probe.workspaceRoot, e);
    const wsJson = join(dir, "workspace.json");
    if (!(await exists(wsJson))) continue;
    let folderUri: string;
    try {
      const raw = await fs.readFile(wsJson, "utf8");
      folderUri = JSON.parse(raw).folder ?? "";
    } catch {
      continue;
    }
    if (!folderUri) continue;
    const decoded = fileUriToPath(folderUri);
    if (!decoded) continue;
    if (targets.has(normalizePath(decoded))) {
      matches.push({
        hash: e,
        dir,
        folderUri,
        dbPath: join(dir, "state.vscdb"),
      });
    }
  }
  return matches;
}

function normalizePath(p: string): string {
  // Windows: lowercase drive letter, forward slashes, strip trailing slash.
  let n = p.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(n)) n = n[0].toLowerCase() + n.slice(1);
  if (n.length > 3 && n.endsWith("/")) n = n.slice(0, -1);
  return n;
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

// ------------- db helpers -------------

function openReadOnly(path: string): DatabaseSync {
  // node:sqlite emits an ExperimentalWarning on load. Suppress only our own
  // noise; keep other warnings visible.
  const origEmit = process.emitWarning;
  process.emitWarning = (w: any, ...rest: any[]) => {
    const msg = typeof w === "string" ? w : w?.message ?? "";
    if (/SQLite is an experimental feature/.test(msg)) return;
    return origEmit.call(process, w, ...rest);
  };
  try {
    return new DatabaseSync(path, { readOnly: true });
  } finally {
    process.emitWarning = origEmit;
  }
}

function readJsonBlob<T = unknown>(raw: unknown): T | null {
  if (raw == null) return null;
  const s = raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : String(raw);
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

// ------------- session listing -------------

type BubbleRow = { key: string; value: Uint8Array };
type ComposerRecord = {
  _v?: number;
  composerId: string;
  createdAt?: number;
  status?: string;
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type: number }>;
  unifiedMode?: string;
  modelConfig?: { modelName?: string; maxMode?: boolean };
};
type Bubble = {
  _v?: number;
  bubbleId: string;
  type: 1 | 2;
  text?: string;
  createdAt?: string;
  toolFormerData?: {
    name?: string;
    tool?: number;
    status?: string;
    params?: string;
    rawArgs?: string;
    result?: string;
  };
  capabilityType?: number;
  thinking?: { text?: string } | null;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
};

export async function listCursorSessions(
  globalDb: DatabaseSync,
  workspaces: CursorWorkspace[],
): Promise<SessionSummary[]> {
  const idSet = new Set<string>();
  for (const ws of workspaces) {
    for (const id of await readComposerIdsForWorkspace(ws)) idSet.add(id);
  }
  const out: SessionSummary[] = [];
  for (const id of idSet) {
    const summary = loadComposerSummary(globalDb, id);
    if (summary) out.push(summary);
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

async function readComposerIdsForWorkspace(ws: CursorWorkspace): Promise<string[]> {
  if (!(await exists(ws.dbPath))) return [];
  const db = openReadOnly(ws.dbPath);
  try {
    const ids = new Set<string>();
    const cdRow = db
      .prepare(`SELECT value FROM ItemTable WHERE key = 'composer.composerData'`)
      .get() as { value?: unknown } | undefined;
    const cd = readJsonBlob<{
      selectedComposerIds?: string[];
      lastFocusedComposerIds?: string[];
    }>(cdRow?.value);
    for (const id of cd?.selectedComposerIds ?? []) ids.add(id);
    for (const id of cd?.lastFocusedComposerIds ?? []) ids.add(id);

    const genRow = db
      .prepare(`SELECT value FROM ItemTable WHERE key = 'aiService.generations'`)
      .get() as { value?: unknown } | undefined;
    const gens = readJsonBlob<Array<{ type?: string; composerId?: string }>>(genRow?.value);
    for (const g of gens ?? []) {
      if (g?.composerId) ids.add(g.composerId);
    }
    return [...ids];
  } finally {
    db.close();
  }
}

function loadComposerSummary(db: DatabaseSync, composerId: string): SessionSummary | null {
  const row = db
    .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
    .get(`composerData:${composerId}`) as { value?: unknown } | undefined;
  const comp = readJsonBlob<ComposerRecord>(row?.value);
  if (!comp) return null;

  const headers = comp.fullConversationHeadersOnly ?? [];
  let userMsgCount = 0;
  let assistantTurnCount = 0;
  let firstUserMsg: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let prevType: number | null = null;

  for (const h of headers) {
    const b = loadBubble(db, composerId, h.bubbleId);
    if (!b) continue;
    if (b.createdAt) {
      if (!firstTs) firstTs = b.createdAt;
      lastTs = b.createdAt;
    }
    if (b.type === 1) {
      userMsgCount++;
      if (!firstUserMsg && b.text) firstUserMsg = b.text.trim().slice(0, 120);
    } else if (b.type === 2) {
      if (prevType !== 2) assistantTurnCount++;
    }
    prevType = b.type;
  }

  const createdAt = comp.createdAt ? new Date(comp.createdAt) : new Date(firstTs ?? 0);
  return {
    id: composerId,
    file: `${comp._v ?? "?"}:composerData:${composerId}`,
    size: JSON.stringify(comp).length,
    mtime: createdAt,
    firstUserMsg,
    firstTs,
    lastTs,
    userMsgCount,
    assistantCount: assistantTurnCount,
    cwd: null,
  };
}

function loadBubble(db: DatabaseSync, composerId: string, bubbleId: string): Bubble | null {
  const row = db
    .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
    .get(`bubbleId:${composerId}:${bubbleId}`) as { value?: unknown } | undefined;
  return readJsonBlob<Bubble>(row?.value);
}

type ResolvedCursorSession = { id: string; workspace: CursorWorkspace | null };

export async function resolveCursorSessionId(
  globalDb: DatabaseSync,
  workspaces: CursorWorkspace[],
  sessionId: string,
): Promise<ResolvedCursorSession | null> {
  if (sessionId === "latest") {
    const list = await listCursorSessions(globalDb, workspaces);
    const top = list[0];
    if (!top) return null;
    return { id: top.id, workspace: await findOwningWorkspace(workspaces, top.id) };
  }

  const direct = globalDb
    .prepare(`SELECT key FROM cursorDiskKV WHERE key = ?`)
    .get(`composerData:${sessionId}`) as { key?: string } | undefined;
  let fullId: string | null = null;
  if (direct?.key) fullId = sessionId;
  else {
    const prefix = globalDb
      .prepare(`SELECT key FROM cursorDiskKV WHERE key LIKE ? LIMIT 1`)
      .get(`composerData:${sessionId}%`) as { key?: string } | undefined;
    if (prefix?.key) fullId = prefix.key.replace(/^composerData:/, "");
  }
  if (!fullId) return null;
  return { id: fullId, workspace: await findOwningWorkspace(workspaces, fullId) };
}

/**
 * Pick the workspace that "owns" this composer — the one whose aiService
 * or composerData mentions it. When multiple workspaces (project + parent)
 * both mention it, prefer the most specific (longest decoded path).
 */
async function findOwningWorkspace(
  workspaces: CursorWorkspace[],
  composerId: string,
): Promise<CursorWorkspace | null> {
  const hits: CursorWorkspace[] = [];
  for (const w of workspaces) {
    const ids = await readComposerIdsForWorkspace(w);
    if (ids.includes(composerId)) hits.push(w);
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const la = (fileUriToPath(a.folderUri) ?? "").length;
    const lb = (fileUriToPath(b.folderUri) ?? "").length;
    return lb - la;
  });
  return hits[0];
}

// ------------- summarization -------------

/**
 * Normalize Cursor's numeric tool IDs / snake_case names into the same
 * PascalCase vocabulary Claude Code uses. Keeps downstream tooling uniform.
 */
export const CURSOR_TOOL_MAP: Record<string, string> = {
  read_file_v2: "Read",
  edit_file_v2: "Edit",
  glob_file_search: "Glob",
  ripgrep_raw_search: "Grep",
  run_terminal_command_v2: "Bash",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  delete_file: "Delete",
  todo_write: "TodoWrite",
  task_v2: "Task",
  await: "Await",
  ask_question: "AskQuestion",
  switch_mode: "SwitchMode",
  create_plan: "CreatePlan",
  read_lints: "ReadLints",
  create_memory: "CreateMemory",
  update_memory: "UpdateMemory",
};

export function normalizeToolName(name: string | undefined): string {
  if (!name) return "Unknown";
  return CURSOR_TOOL_MAP[name] ?? name;
}

export function summarizeCursorComposer(
  db: DatabaseSync,
  composerId: string,
  dbPath: string,
  cwd: string | null,
): string {
  const compRow = db
    .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
    .get(`composerData:${composerId}`) as { value?: unknown } | undefined;
  const comp = readJsonBlob<ComposerRecord>(compRow?.value);
  if (!comp) {
    return renderMarkdown({
      sourceLabel: "Cursor",
      sessionId: composerId,
      file: `${dbPath}#${composerId}`,
      cwd,
      firstTs: null,
      lastTs: null,
      userMsgs: [],
      assistantTurns: [],
      errors: [],
      toolCounts: {},
      filesTouched: new Set(),
      bashCommands: [],
    });
  }

  const userMsgs: UserMsg[] = [];
  const assistantTurns: AssistantTurn[] = [];
  const errors: ErrorHit[] = [];
  const toolCounts: Record<string, number> = {};
  const filesTouched = new Set<string>();
  const bashCommands: string[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  let currentTurn: AssistantTurn | null = null;
  const closeTurn = () => {
    if (currentTurn) {
      assistantTurns.push(currentTurn);
      currentTurn = null;
    }
  };

  for (const h of comp.fullConversationHeadersOnly ?? []) {
    const b = loadBubble(db, composerId, h.bubbleId);
    if (!b) continue;
    const ts = b.createdAt ?? "";
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    if (b.type === 1) {
      closeTurn();
      userMsgs.push({ ts, text: b.text ?? "" });
      continue;
    }

    if (!currentTurn) currentTurn = { ts, text: "", toolUses: [] };
    if (b.text && b.text.trim().length > 0) {
      currentTurn.text += (currentTurn.text ? "\n\n" : "") + b.text;
    }

    const tf = b.toolFormerData;
    if (tf?.name) {
      const toolName = normalizeToolName(tf.name);
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      const parsedParams = safeParse(tf.params) ?? safeParse(tf.rawArgs) ?? {};
      currentTurn.toolUses.push({
        name: toolName,
        brief: briefCursorToolInput(toolName, parsedParams),
      });
      collectCursorToolMeta(toolName, parsedParams, filesTouched, bashCommands);
      const err = detectCursorError(tf, parsedParams);
      if (err) errors.push({ ts, tool: toolName, error: err });
    }
  }
  closeTurn();

  return renderMarkdown({
    sourceLabel: "Cursor",
    sessionId: composerId,
    file: `${dbPath}#${composerId}`,
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

function safeParse(s: string | undefined): any | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function briefCursorToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return String(input.command ?? "").slice(0, 100);
  if (name === "Read") return String(input.relativeWorkspacePath ?? input.path ?? input.targetFile ?? "");
  if (name === "Edit" || name === "Write")
    return String(input.relativeWorkspacePath ?? input.targetFile ?? input.path ?? "");
  if (name === "Glob") return String(input.globPattern ?? input.pattern ?? "");
  if (name === "Grep") return String(input.pattern ?? "");
  if (name === "WebSearch") return String(input.searchTerm ?? input.query ?? "");
  if (name === "WebFetch") return String(input.url ?? "");
  if (name === "Task") return String(input.description ?? "").slice(0, 100);
  if (name === "Delete") return String(input.path ?? input.relativeWorkspacePath ?? "");
  return JSON.stringify(input).slice(0, 100);
}

function collectCursorToolMeta(
  name: string,
  input: any,
  filesTouched: Set<string>,
  bashCommands: string[],
): void {
  if (!input || typeof input !== "object") return;
  if (name === "Edit" || name === "Write" || name === "Delete") {
    const p = input.relativeWorkspacePath ?? input.targetFile ?? input.path;
    if (p) filesTouched.add(String(p));
  }
  if (name === "Bash" && typeof input.command === "string") {
    bashCommands.push(input.command);
  }
}

function detectCursorError(
  tf: NonNullable<Bubble["toolFormerData"]>,
  parsedParams: any,
): string | null {
  if (tf.status && /^(error|failed|rejected)$/i.test(tf.status)) {
    const parsedResult = safeParse(tf.result);
    const msg =
      (parsedResult && (parsedResult.error ?? parsedResult.contents ?? parsedResult.message)) ??
      (typeof tf.result === "string" ? tf.result : "") ??
      JSON.stringify(parsedParams);
    return String(msg).slice(0, 300);
  }
  const parsedResult = safeParse(tf.result);
  if (parsedResult && typeof parsedResult === "object") {
    if (typeof parsedResult.error === "string" && parsedResult.error.trim().length > 0) {
      return parsedResult.error.slice(0, 300);
    }
    if (typeof parsedResult.contents === "string" && /^Error:/.test(parsedResult.contents)) {
      return parsedResult.contents.slice(0, 300);
    }
    if (typeof parsedResult.exitCode === "number" && parsedResult.exitCode !== 0) {
      const out = String(parsedResult.output ?? "").split("\n")[0];
      return `exit ${parsedResult.exitCode}: ${out}`.slice(0, 300);
    }
  }
  return null;
}

function printCursorSessionList(sessions: SessionSummary[], workspaces: CursorWorkspace[]): void {
  process.stdout.write(`# Cursor sessions\n\n`);
  process.stdout.write(`Scanned workspace storage:\n`);
  for (const w of workspaces) {
    process.stdout.write(`- ${w.hash}  ${w.folderUri}\n`);
  }
  process.stdout.write("\n");
  if (sessions.length === 0) {
    process.stdout.write("(none found — workspaces only track currently/recently focused composers)\n");
    return;
  }
  for (const s of sessions) {
    const short = s.id.slice(0, 8);
    const when = s.mtime.toISOString().replace("T", " ").slice(0, 16);
    const msg = s.firstUserMsg ? s.firstUserMsg.replace(/\s+/g, " ") : "(no user msg)";
    process.stdout.write(
      `- **${short}**  ${when}  ${s.userMsgCount}u/${s.assistantCount}a\n`,
    );
    process.stdout.write(`  "${msg}"\n`);
  }
}
