import { platform } from "node:os";
import { resolveHandoffPaths } from "../format/paths.js";
import { exists } from "../util/fs.js";
import { buildPrimer, buildStandingRulesContext } from "./prime.js";
import { save } from "./save.js";
import { attempt } from "./attempt.js";
import { autoCapture } from "./auto-capture.js";

export type HookEvent =
  | "session-start"
  | "user-prompt-submit"
  | "stop"
  | "pre-compact"
  | "rate-limit";

/**
 * The JSON payload Claude Code delivers on stdin to a hook command. For Stop /
 * PreCompact the interesting fields are `transcript_path` (the full session
 * JSONL) and `stop_hook_active` (re-entrancy guard).
 */
export type HookPayload = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
};

type HookOpts = { event: HookEvent; cwd?: string; payload?: HookPayload };

/**
 * Subcommand: `handoff hook <event>`
 *
 * Runs inside Claude Code hook commands. Output to stdout is meaningful
 * (SessionStart injects it as context); stderr is user-visible text; we
 * must not print anything we don't want Claude to see.
 */
export async function hook(opts: HookOpts): Promise<void> {
  const cwd = opts.cwd ?? opts.payload?.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    // No .handoff/ in this project: silently pass, injecting nothing.
    return;
  }

  if (opts.event === "session-start") {
    // Deliberately not gated on payload.source: SessionStart re-fires after a
    // compaction (source "compact") and on resume/clear/fork, and re-injecting
    // the primer at each of those is exactly what we want.
    const primer = await buildPrimer(paths, "claude-code", 9000);
    const payload = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: primer,
      },
    };
    await writeStdout(JSON.stringify(payload) + "\n");
    return;
  }

  if (opts.event === "user-prompt-submit") {
    // Mid-session drift guard. SessionStart covers startup and post-compaction;
    // this covers the long stretch in between, where a constraint logged 200
    // turns ago quietly stops being honoured. Standing rules only — emitting
    // the whole primer on every prompt would be a large recurring token cost.
    const rules = await buildStandingRulesContext(paths);
    if (!rules) return; // nothing durable logged yet: stay silent, cost nothing
    const payload = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: rules,
      },
    };
    await writeStdout(JSON.stringify(payload) + "\n");
    return;
  }

  if (opts.event === "stop") {
    // Refresh environment snapshot so the next session / tool sees current state.
    // Keep save quiet: redirect its console.log to stderr (non-fatal if it fails).
    const originalLog = console.log;
    console.log = (...args: unknown[]) => console.error(...args);
    try {
      await save({ cwd });
    } finally {
      console.log = originalLog;
    }
    // Auto-capture failed attempts + corrections from the transcript. This must
    // NEVER break the session: swallow everything and exit clean.
    try {
      await autoCapture({ cwd, paths, payload: opts.payload });
    } catch {
      /* auto-capture is best-effort; a Stop hook must always succeed */
    }
    return;
  }

  if (opts.event === "pre-compact") {
    // Same curated auto-capture as Stop, before the transcript gets compacted.
    try {
      await autoCapture({ cwd, paths, payload: opts.payload });
    } catch {
      /* best-effort; never break compaction */
    }
    return;
  }

  if (opts.event === "rate-limit") {
    /* fallthrough */
    await attempt({
      what: "hit Claude Code rate limit",
      error: "rate_limit error — Claude Code session blocked",
      fix: "swap to another tool: run `handoff prime --tool <codex|cursor|gemini>` and paste",
      cwd,
    });
    console.error(
      "\n👋 rate limit hit. your handoff is fresh.\n" +
        `   run: handoff prime --tool codex | ${clipHintForPlatform()}\n` +
        "   then paste into Codex (or Cursor, Gemini, etc.)\n",
    );
    return;
  }
}

function clipHintForPlatform(): string {
  const plat = platform();
  if (plat === "win32") return "clip";
  if (plat === "darwin") return "pbcopy";
  return "wl-copy";
}

function writeStdout(s: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(s, (err) => (err ? reject(err) : resolve()));
  });
}
