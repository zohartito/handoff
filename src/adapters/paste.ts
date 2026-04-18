import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { resolveHandoffPaths } from "../format/paths.js";
import { writeFileSafe } from "../util/fs.js";
import {
  renderMarkdown,
  emitOutput,
  type AssistantTurn,
  type UserMsg,
} from "../commands/ingest.js";

/**
 * Paste adapter for `handoff ingest --from paste`.
 *
 * Unlike claude-code/cursor/codex/gemini, Claude Desktop and ChatGPT web leave
 * no log file on disk — users have to paste transcripts by hand. This adapter
 * accepts that raw paste from a file, stdin, or the system clipboard and:
 *
 *   1. Writes the verbatim text to `.handoff/transcript.md` (NEW file — not
 *      jsonl, since pasted chat is not structured)
 *   2. Produces a markdown summary via the shared `renderMarkdown()` so the
 *      output shape matches every other source adapter
 *
 * The summary is a best-effort view: pasted text is freeform, so timestamps,
 * tool calls, and assistant turns stay unknown. User-message count is
 * heuristic — lines starting with common speaker markers (User:, You:, Me:,
 * Human:, Q:, Prompt:) are tallied.
 */

export type PasteIngestOpts = {
  file?: string;
  stdin?: boolean;
  clipboard?: boolean;
  out?: string;
  project: string; // absolute project path
};

export async function ingestPaste(opts: PasteIngestOpts): Promise<void> {
  const modeCount = countSelectedModes(opts);
  if (modeCount === 0) {
    console.error(
      `ingest --from paste requires one input mode.\n` +
        `  use one of: --file <path> | --stdin | --clipboard`,
    );
    process.exitCode = 1;
    return;
  }
  if (modeCount > 1) {
    console.error(
      `ingest --from paste: --file, --stdin, and --clipboard are mutually exclusive.\n` +
        `  pick exactly one input mode.`,
    );
    process.exitCode = 1;
    return;
  }

  let text: string;
  let sourceDescriptor: string;
  try {
    const read = await readPasteInput(opts);
    text = read.text;
    sourceDescriptor = read.source;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`could not read pasted transcript: ${msg}`);
    process.exitCode = 1;
    return;
  }

  if (text.trim().length === 0) {
    console.error(
      `pasted transcript is empty (source: ${sourceDescriptor}).\n` +
        `  nothing to ingest.`,
    );
    process.exitCode = 1;
    return;
  }

  // 1. Persist raw paste to .handoff/transcript.md
  const paths = resolveHandoffPaths(opts.project);
  const transcriptMd = join(paths.dir, "transcript.md");
  const payload = text.endsWith("\n") ? text : text + "\n";
  await writeFileSafe(transcriptMd, payload);

  // 2. Render summary with the shared section layout
  const output = renderPasteSummary({ text, source: sourceDescriptor });
  await emitOutput(output, opts.out, opts.project);
}

/**
 * Build a paste summary for `handoff ingest --all`. Returns null when no
 * paste has been captured for this project — i.e. `.handoff/transcript.md`
 * does not exist. Used by `defaultIngestAllSources`.
 */
export async function buildPasteSummary(opts: {
  project: string;
}): Promise<string | null> {
  const paths = resolveHandoffPaths(opts.project);
  const transcriptMd = join(paths.dir, "transcript.md");
  let text: string;
  try {
    text = await fs.readFile(transcriptMd, "utf8");
  } catch {
    return null;
  }
  if (text.trim().length === 0) return null;
  return renderPasteSummary({ text, source: transcriptMd });
}

// ------------- input reading -------------

function countSelectedModes(opts: PasteIngestOpts): number {
  let n = 0;
  if (typeof opts.file === "string" && opts.file.length > 0) n++;
  if (opts.stdin === true) n++;
  if (opts.clipboard === true) n++;
  return n;
}

type ReadResult = { text: string; source: string };

async function readPasteInput(opts: PasteIngestOpts): Promise<ReadResult> {
  if (typeof opts.file === "string" && opts.file.length > 0) {
    const text = await fs.readFile(opts.file, "utf8");
    return { text, source: opts.file };
  }
  if (opts.stdin === true) {
    const text = await readStdin();
    return { text, source: "stdin" };
  }
  if (opts.clipboard === true) {
    const text = await readClipboard();
    return { text, source: "clipboard" };
  }
  // Unreachable given mode-count validation in ingestPaste.
  throw new Error("no input mode selected");
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.on("end", () =>
      resolvePromise(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", (err) => rejectPromise(err));
  });
}

/**
 * Pipe-read the system clipboard via the platform-native utility. Mirrors
 * the write-side clipboard logic in `src/commands/switch.ts`:
 *   - Windows: powershell Get-Clipboard (no builtin `clip` equivalent)
 *   - macOS:   pbpaste
 *   - Linux:   wl-paste → xclip -selection clipboard -o → xsel --clipboard --output
 */
async function readClipboard(): Promise<string> {
  const candidates = clipReadCommands();
  for (const [cmd, args] of candidates) {
    const result = await tryReadClip(cmd, args);
    if (result !== null) return result;
  }
  throw new Error(
    `no clipboard read utility available\n` +
      `  tried: ${candidates.map((c) => c[0]).join(", ")}`,
  );
}

function clipReadCommands(): Array<[string, string[]]> {
  if (platform() === "win32") {
    return [["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]];
  }
  if (platform() === "darwin") {
    return [["pbpaste", []]];
  }
  // linux: try Wayland first, then X11 fallbacks.
  return [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ];
}

function tryReadClip(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c) => chunks.push(Buffer.from(c)));
      child.on("error", () => resolvePromise(null));
      child.on("exit", (code) => {
        if (code !== 0) {
          resolvePromise(null);
          return;
        }
        resolvePromise(Buffer.concat(chunks).toString("utf8"));
      });
    } catch {
      resolvePromise(null);
    }
  });
}

// ------------- rendering -------------

/**
 * Heuristics to pull user-message count from freeform pasted chat. Matches
 * common speaker markers at start of a line: `User:`, `You:`, `Me:`,
 * `Human:`, `Q:`, `Prompt:` — case-insensitive, tolerant of leading
 * whitespace and markdown bold wrappers (`**User:**`, `**You:**`).
 */
const USER_MARKER_RE = /^\s*(?:\*\*)?\s*(?:user|you|me|human|q|prompt)\s*(?:\*\*)?\s*:/i;
const ASSISTANT_MARKER_RE =
  /^\s*(?:\*\*)?\s*(?:assistant|claude|chatgpt|gpt|a|ai|bot|model|answer)\s*(?:\*\*)?\s*:/i;

export function countPasteUserMessages(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (USER_MARKER_RE.test(line)) count++;
  }
  return count;
}

export function countPasteAssistantTurns(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (ASSISTANT_MARKER_RE.test(line)) count++;
  }
  return count;
}

/**
 * Extract up to `limit` heuristic user messages (one-line snippets) from
 * pasted text. Returns empty array when no markers match — `renderMarkdown`
 * already handles the empty-case with _(none)_, so no synthetic entry.
 */
export function extractPasteUserMsgs(text: string, limit = 50): UserMsg[] {
  if (!text) return [];
  const out: UserMsg[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!USER_MARKER_RE.test(line)) continue;
    const snippet = line.replace(USER_MARKER_RE, "").trim().slice(0, 400);
    if (snippet.length === 0) continue;
    out.push({ ts: "", text: snippet });
    if (out.length >= limit) break;
  }
  return out;
}

export function renderPasteSummary(opts: { text: string; source: string }): string {
  const { text, source } = opts;
  const userMsgs = extractPasteUserMsgs(text);
  const assistantCount = countPasteAssistantTurns(text);
  // We don't parse assistant prose reliably — surface the count via a
  // synthetic empty turn list so the rendered header reflects it.
  const assistantTurns: AssistantTurn[] = [];
  for (let i = 0; i < assistantCount; i++) {
    assistantTurns.push({ ts: "", text: "", toolUses: [] });
  }

  // Fallback user count for the markdown metadata line — if our heuristic
  // found none but the paste has text, show "?" so downstream readers know
  // it wasn't zero, just unknowable.
  const userMsgsForRender: UserMsg[] =
    userMsgs.length > 0 ? userMsgs : fallbackUserMsgs(text);

  return renderMarkdown({
    sourceLabel: "Pasted transcript",
    sessionId: null,
    file: source,
    cwd: null,
    firstTs: null,
    lastTs: null,
    userMsgs: userMsgsForRender,
    assistantTurns,
    errors: [],
    toolCounts: {},
    filesTouched: new Set<string>(),
    bashCommands: [],
  });
}

function fallbackUserMsgs(text: string): UserMsg[] {
  // No speaker markers matched — return a single synthetic entry pointing
  // at the first non-empty line so the summary has something human-readable.
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return [];
  return [{ ts: "", text: `(unparsed paste — first line: "${firstLine.slice(0, 200)}")` }];
}
