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

/**
 * Cues that mark a user message as a correction.
 *
 * Anchored to a SENTENCE boundary, not just the start of the message. Requiring
 * the message to *open* with a cue was measured against 395 real user messages
 * across 15 sessions and caught **zero** — people lead with context and correct
 * in the second sentence ("I tried that. No, don't use os.path here.").
 */
const CORRECTION_CUE =
  /(^|[.!?]\s+)(no,|nope\b|don'?t\b|do not\b|stop\b|actually,|that'?s (wrong|not|incorrect)|not what|you (shouldn'?t|should have)|why did you|undo\b|revert\b|instead,|I said\b|I asked\b|never (do|use|say|add)|that was wrong)/i;

/**
 * Max correction message length.
 *
 * Was 240, which excluded 70% of real messages outright — the measured median
 * is 425 characters. 1000 covers the bulk without swallowing whole essays.
 */
const MAX_CORRECTION_CHARS = 1000;

/** Only look this far in for the cue — a correction states itself early. */
const CUE_SEARCH_WINDOW = 300;

/**
 * Text the harness injects into the transcript that is NOT the user speaking:
 * slash-command expansions, local-command output, hook payloads. Read as user
 * messages these produce corrections attributed to a human who never typed them.
 */
const INJECTED_ARTIFACT =
  /^\s*<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|user-prompt-submit-hook|system-reminder)\b/i;

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
 * **Read the limits before trusting this.** Measured against 395 real user
 * messages over 15 sessions, the original rules (message must be <=240 chars and
 * must *open* with a cue) caught zero. Widening the window and the length cap
 * takes that to a handful — still only a few percent, because most real
 * corrections carry no cue word at all. People correct by explaining:
 * "But the whole idea is that they didn't turn it on at the beginning" is a
 * correction, and no lexical rule will ever see it.
 *
 * So this is a safety net, not the mechanism. The mechanism is asking the
 * outgoing agent to write the handoff while it still remembers. Anything that
 * describes auto-capture as making handoff work "without discipline" is
 * overselling it.
 */
export function detectCorrections(session: ParsedSession): Correction[] {
  const out: Correction[] = [];
  for (const turn of session.userTurns) {
    const text = turn.text.trim();
    if (text.length === 0 || text.length > MAX_CORRECTION_CHARS) continue;
    // Harness-injected blocks are not the user speaking.
    if (INJECTED_ARTIFACT.test(text)) continue;
    // First user message of the whole session is the task, never a correction.
    if (session.startLine === 0 && turn.index === 0) continue;
    if (!CORRECTION_CUE.test(text.slice(0, CUE_SEARCH_WINDOW))) continue;
    out.push({
      agentDid: turn.precedingAssistant ?? "(no preceding assistant turn)",
      userSaid: text,
    });
  }
  return out;
}

/**
 * Session constraints: rules the user states for this session ("ask me before
 * you migrate", "don't mention my employer"). They are neither the task nor a
 * correction, so `detectCorrections` never sees them (it skips the first message
 * and needs a correction cue), and context compaction is exactly where they get
 * lost. Captured into corrections.md, they ride `extractConstraints` into the
 * verbatim block of every compacted primer.
 *
 * Phrases that are directives wherever they appear in a sentence.
 */
const CONSTRAINT_ANYWHERE =
  /\b(ask me first|without asking|from now on|for this session|make sure|confirm with me|(don'?t|do not) (mention|reveal|call me))\b/i;
/** Cues that are only directives at the start of a sentence ("Never X", not "it never X"). */
const CONSTRAINT_LEADING =
  /^(?:(?:please|also|and|but|just|ok|okay|so)[,\s]+)*(always|never|confirm|before you)\b/i;
/** Modal directives addressed to the agent. */
const CONSTRAINT_MODAL = /\byou (must|should always|should never)\b/i;
/** Interrogative openers: a question asks, it doesn't set a rule. */
const QUESTION_OPENER =
  /^(can|could|would|should|did|do|does|is|are|will|why|what|how|when)\b/i;
/** Per-sentence cap: a rule is one sentence, not a paragraph. */
const MAX_CONSTRAINT_CHARS = 300;

export type SessionConstraint = {
  /** The directive sentence, verbatim. */
  text: string;
  /** Index of the user turn it came from. */
  turnIndex: number;
};

/**
 * Pull directive sentences out of every user turn, the first message included.
 * Lexical and verbatim: the sentence is kept exactly as typed, never rephrased.
 */
export function detectSessionConstraints(session: ParsedSession): SessionConstraint[] {
  const out: SessionConstraint[] = [];
  for (const turn of session.userTurns) {
    if (INJECTED_ARTIFACT.test(turn.text)) continue;
    const sentences = turn.text
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+/))
      .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim());
    for (const s of sentences) {
      if (s.length < 8 || s.length > MAX_CONSTRAINT_CHARS) continue;
      if (s.endsWith("?") || QUESTION_OPENER.test(s)) continue;
      if (
        CONSTRAINT_ANYWHERE.test(s) ||
        CONSTRAINT_LEADING.test(s) ||
        CONSTRAINT_MODAL.test(s)
      ) {
        out.push({ text: s, turnIndex: turn.index });
      }
    }
  }
  return out;
}

export type AutoCaptureOpts = {
  cwd?: string;
  paths?: HandoffPaths;
  payload?: HookPayload;
};

/**
 * Auto-capture failed attempts, corrections and session constraints from a session transcript when a
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

  // Session constraints, logged as corrections so the compacted primer carries
  // them verbatim. Skip a rule already inside a correction logged this run.
  const constraints = detectSessionConstraints(session)
    .filter((sc) => !corrections.some((c) => c.userSaid.includes(sc.text)))
    .slice(-MAX_PER_STOP);
  for (const sc of constraints) {
    const h = hashEntry("correct", [sc.text]);
    if (state.seenHashes.includes(h) || newHashes.includes(h)) continue;
    try {
      await correct({
        action: "(session constraint stated by the user)",
        userSaid: sc.text,
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
