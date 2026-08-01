import { promises as fs } from "node:fs";
import { resolveHandoffPaths, type HandoffPaths } from "../format/paths.js";
import { exists } from "../util/fs.js";
import {
  loadCaptureState,
  saveCaptureState,
  pushHashes,
  hashEntry,
} from "../util/capture-state.js";
import { parseSessionEvents, type ParsedSession } from "./ingest.js";
import { attempt } from "./attempt.js";
import { correct } from "./correct.js";
import type { HookPayload } from "./hook.js";

// Re-export so tests (and the spec's public surface) can import the pure hash
// helper from the auto-capture module.
export { hashEntry } from "../util/capture-state.js";

/** Bash commands that count as meaningful work (build/test/etc.). */
const MEANINGFUL_WORK =
  /\b(test|build|lint|tsc|npm run|pnpm|yarn|make|cargo|pytest|go test|compile|install)\b/;

/** Error text that indicates a real failure (not just noisy output). */
const REAL_FAILURE =
  /error|failed|not found|cannot|exit code [1-9]|ENOENT|ERR!|Traceback|FAIL/i;

/** Opening cues that mark a user message as a correction. */
const CORRECTION_CUE =
  /^(no\b|nope\b|don'?t\b|do not\b|stop\b|wait\b|actually\b|that'?s (wrong|not|incorrect)|not (what|quite)|you (shouldn'?t|should have)|why did you|undo\b|revert\b|instead\b|I said\b|I asked\b)/i;

/** Max correction message length; longer messages are treated as new asks. */
const MAX_CORRECTION_CHARS = 240;

/** Max auto entries of each kind written per Stop (keep the freshest). */
const MAX_PER_STOP = 3;

export type FailedAttempt = {
  command: string;
  error: string;
  fix?: string;
};

export type Correction = {
  agentDid: string;
  userSaid: string;
};

/** Extract the leading meaningful-work keyword from a command, if any. */
function meaningfulVerb(command: string): string | null {
  const m = command.match(MEANINGFUL_WORK);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Detect failed build/test/etc. Bash commands worth logging.
 *
 * Only Bash tool_uses are considered (Read/Grep/Glob/LS/WebFetch/WebSearch are
 * never in `bashCalls`). The command must look like meaningful work and the
 * error text must carry a real-failure token. `fix` is set only when a later
 * same-verb Bash command succeeded.
 */
export function detectFailedAttempts(session: ParsedSession): FailedAttempt[] {
  const out: FailedAttempt[] = [];
  const calls = session.bashCalls;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call.isError) continue;
    const cmd = call.command.trim();
    if (!cmd) continue;
    if (!MEANINGFUL_WORK.test(cmd)) continue;
    if (!REAL_FAILURE.test(call.errorText)) continue;

    const verb = meaningfulVerb(cmd);
    let fix: string | undefined;
    if (verb) {
      for (let j = i + 1; j < calls.length; j++) {
        const later = calls[j];
        if (!later.isError && meaningfulVerb(later.command) === verb) {
          fix = "later succeeded — see transcript";
          break;
        }
      }
    }
    out.push({ command: cmd, error: call.errorText, fix });
  }
  return out;
}

/**
 * Detect user messages that correct the agent.
 *
 * A candidate is short, is not the first user message of the session, and opens
 * with a correction cue. `agentDid` is a one-line summary of the assistant turn
 * that preceded the correction.
 */
export function detectCorrections(session: ParsedSession): Correction[] {
  const out: Correction[] = [];
  for (const turn of session.userTurns) {
    const text = turn.text.trim();
    if (text.length === 0 || text.length > MAX_CORRECTION_CHARS) continue;
    // First user message of the whole session is the task, never a correction.
    if (session.startLine === 0 && turn.index === 0) continue;
    if (!CORRECTION_CUE.test(text)) continue;
    out.push({
      agentDid: turn.precedingAssistant ?? "(no preceding assistant turn)",
      userSaid: text,
    });
  }
  return out;
}

export type AutoCaptureOpts = {
  cwd?: string;
  paths?: HandoffPaths;
  payload?: HookPayload;
};

/**
 * Auto-capture failed attempts and corrections from a session transcript when a
 * Stop / PreCompact hook fires. Curated logs only — never writes a transcript,
 * never emits decisions, never writes to stdout, and never throws out (callers
 * still wrap it defensively). A missing transcript or absent `.handoff/` is a
 * silent no-op.
 */
export async function autoCapture(opts: AutoCaptureOpts): Promise<void> {
  const payload = opts.payload ?? {};

  // Re-entrancy guard: never act while already inside a Stop-hook continuation.
  if (payload.stop_hook_active === true) return;

  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : undefined;
  if (!transcriptPath) return;

  const cwd = opts.cwd ?? payload.cwd ?? process.cwd();
  const paths = opts.paths ?? resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) return;
  if (!(await exists(transcriptPath))) return;

  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(transcriptPath)).mtimeMs;
  } catch {
    /* stat failure is non-fatal — cursor mtime stays 0 */
  }

  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.length > 0
      ? payload.session_id
      : transcriptPath;

  const state = await loadCaptureState(paths.captureState);
  const fromLine = state.sessions[sessionId]?.lastLineProcessed ?? 0;

  const session = await parseSessionEvents(transcriptPath, fromLine);

  // Keep the freshest N of each kind.
  const attempts = detectFailedAttempts(session).slice(-MAX_PER_STOP);
  const corrections = detectCorrections(session).slice(-MAX_PER_STOP);

  const newHashes: string[] = [];

  for (const a of attempts) {
    const h = hashEntry("attempt", [a.command]);
    if (state.seenHashes.includes(h) || newHashes.includes(h)) continue;
    try {
      await attempt({
        what: a.command,
        error: a.error || undefined,
        fix: a.fix,
        source: "auto",
        quiet: true,
        cwd,
      });
      newHashes.push(h);
    } catch {
      /* a single lock/IO failure must not abort the rest of the capture */
    }
  }

  for (const c of corrections) {
    const h = hashEntry("correct", [c.userSaid]);
    if (state.seenHashes.includes(h) || newHashes.includes(h)) continue;
    try {
      await correct({
        action: c.agentDid,
        userSaid: c.userSaid,
        source: "auto",
        quiet: true,
        cwd,
      });
      newHashes.push(h);
    } catch {
      /* per-entry failure is swallowed */
    }
  }

  // Advance the cursor and remember what we logged, so a re-run is idempotent.
  pushHashes(state, newHashes);
  state.sessions[sessionId] = {
    lastLineProcessed: session.linesProcessed,
    lastMtimeMs: mtimeMs,
  };
  try {
    await saveCaptureState(paths.captureState, state);
  } catch {
    /* if we can't persist the cursor, next Stop re-scans — dedup by hash still holds */
  }
}
