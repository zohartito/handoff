import { platform } from "node:os";
import { resolveHandoffPaths } from "../format/paths.js";
import { exists } from "../util/fs.js";
import { buildPrimer } from "./prime.js";
import { save } from "./save.js";
import { attempt } from "./attempt.js";

export type HookEvent = "session-start" | "stop" | "rate-limit";

type HookOpts = { event: HookEvent; cwd?: string };

/**
 * Subcommand: `handoff hook <event>`
 *
 * Runs inside Claude Code hook commands. Output to stdout is meaningful
 * (SessionStart injects it as context); stderr is user-visible text; we
 * must not print anything we don't want Claude to see.
 */
export async function hook(opts: HookOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    // No .handoff/ in this project: silently pass, injecting nothing.
    return;
  }

  if (opts.event === "session-start") {
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
