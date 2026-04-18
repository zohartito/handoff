import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists, readOrEmpty, writeFileSafe } from "../util/fs.js";
import { withFileLock } from "../util/lock.js";

export type CaptureMode = "full" | "summary";

export type CaptureSource =
  | { kind: "stdin" }
  | { kind: "file"; path: string };

export type CaptureOpts = {
  source: CaptureSource;
  mode?: CaptureMode;
  taskPath?: string;
  decisionsPath?: string;
  correctionsPath?: string;
  cwd?: string;
  /** Injected for tests; real callers should not pass this. */
  stdin?: NodeJS.ReadableStream;
};

/**
 * End-of-session transcript dump meant to be run by the outgoing AI.
 *
 * Reads a raw transcript from stdin or a file, appends it (with a timestamped
 * separator) to `.handoff/transcript.md`, and — in full mode — extracts simple
 * marker-prefixed lines (DECISION:, TODO:, CORRECTION:, TASK:) into the
 * corresponding `.handoff/` markdown files.
 */
export async function capture(opts: CaptureOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);
  const mode: CaptureMode = opts.mode ?? "full";

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  let transcript: string;
  try {
    transcript = await loadTranscript(opts);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const ts = new Date().toISOString();
  const transcriptPath = resolve(paths.dir, "transcript.md");
  await withFileLock(transcriptPath, () =>
    appendTranscript(transcriptPath, transcript, ts),
  );

  if (mode === "summary") {
    console.log(`captured transcript at ${ts} (summary mode)`);
    return;
  }

  const targets = {
    task: opts.taskPath ?? paths.task,
    decisions: opts.decisionsPath ?? paths.decisions,
    corrections: opts.correctionsPath ?? paths.corrections,
    progress: paths.progress,
  };

  const extracted = extractMarkers(transcript);
  const counts = {
    task: 0,
    todo: 0,
    decision: 0,
    correction: 0,
  };

  if (extracted.task.length > 0) {
    await withFileLock(targets.task, () =>
      appendMarkerBlock(targets.task, "TASK", extracted.task, ts),
    );
    counts.task = extracted.task.length;
  }
  if (extracted.todo.length > 0) {
    await withFileLock(targets.progress, () =>
      appendMarkerBlock(targets.progress, "TODO", extracted.todo, ts),
    );
    counts.todo = extracted.todo.length;
  }
  if (extracted.decision.length > 0) {
    await withFileLock(targets.decisions, () =>
      appendMarkerBlock(targets.decisions, "DECISION", extracted.decision, ts),
    );
    counts.decision = extracted.decision.length;
  }
  if (extracted.correction.length > 0) {
    await withFileLock(targets.corrections, () =>
      appendMarkerBlock(
        targets.corrections,
        "CORRECTION",
        extracted.correction,
        ts,
      ),
    );
    counts.correction = extracted.correction.length;
  }

  console.log(
    `captured transcript at ${ts} ` +
      `(task:${counts.task}, todo:${counts.todo}, ` +
      `decision:${counts.decision}, correction:${counts.correction})`,
  );
}

async function loadTranscript(opts: CaptureOpts): Promise<string> {
  const { source } = opts;
  if (source.kind === "file") {
    try {
      return await readFile(source.path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`capture: transcript file not found: ${source.path}`);
      }
      throw err;
    }
  }
  const stream = opts.stdin ?? process.stdin;
  return readStreamToString(stream);
}

async function readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function appendTranscript(
  path: string,
  transcript: string,
  ts: string,
): Promise<void> {
  const existing = await readOrEmpty(path);
  const body = transcript.endsWith("\n") ? transcript : transcript + "\n";
  if (existing.length === 0) {
    const header = `# Session transcript\n\n---\n## Session ${ts}\n\n`;
    await writeFileSafe(path, header + body);
    return;
  }
  const prefix = existing.endsWith("\n") ? "" : "\n";
  const section = `${prefix}\n---\n## Session ${ts}\n\n${body}`;
  await writeFileSafe(path, existing + section);
}

type Extracted = {
  task: string[];
  todo: string[];
  decision: string[];
  correction: string[];
};

/**
 * Scan the transcript for lines prefixed with one of our markers. The marker
 * can appear at the start of a line (optionally after list bullets or
 * whitespace) and is matched case-insensitively followed by ':'. The text
 * after the colon (trimmed) is the captured entry.
 */
export function extractMarkers(transcript: string): Extracted {
  const out: Extracted = { task: [], todo: [], decision: [], correction: [] };
  const pattern = /^[\s>*\-+]*(TASK|TODO|DECISION|CORRECTION)\s*:\s*(.+?)\s*$/i;
  for (const raw of transcript.split(/\r?\n/)) {
    const m = raw.match(pattern);
    if (!m) continue;
    const label = m[1]!.toUpperCase();
    const content = m[2]!.trim();
    if (content.length === 0) continue;
    switch (label) {
      case "TASK":
        out.task.push(content);
        break;
      case "TODO":
        out.todo.push(content);
        break;
      case "DECISION":
        out.decision.push(content);
        break;
      case "CORRECTION":
        out.correction.push(content);
        break;
    }
  }
  return out;
}

async function appendMarkerBlock(
  path: string,
  label: string,
  items: string[],
  ts: string,
): Promise<void> {
  const bullets = items.map((x) => `- ${x}`).join("\n");
  const block = [
    ``,
    `## ${ts} — captured ${label.toLowerCase()}s`,
    ``,
    bullets,
    ``,
    `---`,
    ``,
  ].join("\n");
  await appendLine(path, block);
}
