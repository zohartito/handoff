import { spawn } from "node:child_process";
import { platform } from "node:os";
import { resolveHandoffPaths } from "../format/paths.js";
import { exists } from "../util/fs.js";
import { buildPrimer, type Tool } from "./prime.js";
import { save } from "./save.js";
import { resolveTrustedExecutable } from "../util/executable.js";

type SwitchOpts = {
  tool: Tool;
  cwd?: string;
  noSave?: boolean;
  noLaunch?: boolean; // copy-only mode
};

/**
 * Subcommand: `handoff switch <tool>`
 *
 * One-shot tool-to-tool handoff: refresh state, build primer, copy to
 * clipboard, launch target tool in cwd. The clipboard is the "serialized
 * agent brain" for tools that don't have hooks or MCP yet.
 *
 * Claude Code is a special case — its hooks auto-inject via
 * `handoff hook session-start`, so we skip the clipboard copy and just
 * launch it.
 */
const SWITCH_TOOLS: ReadonlySet<string> = new Set([
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "gemini",
]);

export async function switchTool(opts: SwitchOpts): Promise<void> {
  if (!SWITCH_TOOLS.has(opts.tool)) {
    console.error(
      `unknown tool: ${opts.tool} (valid: ${[...SWITCH_TOOLS].join(", ")})`,
    );
    process.exitCode = 1;
    return;
  }

  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not found. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  // 1. Refresh state (optional — defaults on)
  if (!opts.noSave) {
    // Keep save quiet on stderr; we're about to print our own output.
    const originalLog = console.log;
    console.log = (...args: unknown[]) => console.error(...args);
    try {
      await save({ cwd });
    } finally {
      console.log = originalLog;
    }
  }

  // 2. Build primer for the target tool
  const primer = await buildPrimer(paths, opts.tool, Infinity);

  // 3. Clipboard — skipped for claude-code (hooks auto-inject)
  const autoInjected = opts.tool === "claude-code";
  if (!autoInjected) {
    const copied = await writeClipboard(primer);
    if (!copied) {
      process.stderr.write(
        "⚠  couldn't copy to clipboard automatically.\n" +
          `   run manually: handoff prime --tool ${opts.tool} | ${clipCommandName()}\n`,
      );
    }
  }

  // 4. Launch the target tool (unless --no-launch).
  // Claude Desktop is a GUI app with no reliable CLI launch shim across
  // platforms, so we never attempt launch for it — the user opens it
  // manually and pastes from clipboard.
  const canLaunch = opts.tool !== "claude-desktop";
  const effectiveNoLaunch = opts.noLaunch === true || !canLaunch;
  if (!effectiveNoLaunch) {
    const launched = await launchTool(opts.tool, cwd);
    if (!launched) {
      // Two common causes: the binary isn't on PATH, or it's a terminal UI that
      // won't run detached without a TTY. Either way the primer is already on
      // the clipboard, so opening the tool by hand loses nothing.
      process.stderr.write(
        `⚠  couldn't launch ${opts.tool} automatically.\n` +
          `   check it's on PATH — terminal tools may also need to be opened in your own shell.\n` +
          `   the primer is already on your clipboard: open ${opts.tool} and paste.\n`,
      );
    }
  }

  // 5. Tell the user what happened
  printSummary(opts.tool, autoInjected, effectiveNoLaunch);
}

// ------------- clipboard -------------

function clipCommandName(): string {
  if (platform() === "win32") return "clip";
  if (platform() === "darwin") return "pbcopy";
  return "wl-copy  (or xclip -selection clipboard, or xsel --clipboard)";
}

/**
 * Pipe the string to the platform's clipboard utility via stdin.
 * Returns true if a utility exited cleanly.
 *
 * On Linux we try a prioritized list: wl-copy (Wayland) → xclip (X11) →
 * xsel (X11 fallback). First one that's on PATH and exits 0 wins.
 */
function writeClipboard(content: string): Promise<boolean> {
  const candidates = clipCommands();
  return tryClipCandidates(candidates, content);
}

async function tryClipCandidates(
  candidates: Array<[string, string[]]>,
  content: string,
): Promise<boolean> {
  for (const [cmd, args] of candidates) {
    const ok = await tryOneClip(cmd, args, content);
    if (ok) return true;
  }
  return false;
}

async function tryOneClip(cmd: string, args: string[], content: string): Promise<boolean> {
  const executable = await resolveTrustedExecutable(cmd, process.cwd());
  if (!executable) return false;
  return new Promise((resolve) => {
    try {
      const child = spawn(executable, args, { stdio: ["pipe", "ignore", "ignore"], shell: false });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
      child.stdin.end(content, "utf8");
    } catch {
      resolve(false);
    }
  });
}

function clipCommands(): Array<[string, string[]]> {
  if (platform() === "win32") return [["clip", []]];
  if (platform() === "darwin") return [["pbcopy", []]];
  // Linux: Wayland first (most modern distros), then X11 fallbacks.
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}

// ------------- tool launch -------------

/**
 * Launch the target tool, opened at cwd, detached so our process doesn't
 * block on it. Returns true if spawn succeeded (not if the tool itself
 * later exits cleanly).
 */
/**
 * How long to wait before concluding a launched tool actually stayed up.
 *
 * This has to outlast a fast self-exit. Terminal agents (codex, gemini, claude)
 * are TUIs: spawned detached with stdio "ignore" they have no TTY and bail
 * immediately with a non-zero code. We previously resolved `true` on a 100ms
 * timer regardless, so `handoff switch codex` printed "✓ launching codex..."
 * and told the user to paste into a tool that had already died.
 */
export const LAUNCH_SETTLE_MS = 400;

/**
 * Spawn a detached process and report whether it actually stayed up.
 *
 * Resolves false if the binary is missing, or if the child exits non-zero
 * inside the settle window; true if it's still running when the window closes.
 * Exported for tests — `launchTool` is just this plus the tool→command map.
 */
export async function spawnDetached(
  cmd: string,
  args: string[],
  cwd: string,
  settleMs: number = LAUNCH_SETTLE_MS,
): Promise<boolean> {
  const executable = await resolveTrustedExecutable(cmd, cwd);
  if (!executable) return false;
  return new Promise((resolve) => {
    try {
      const child = spawn(executable, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        // Never invoke cmd.exe: repository-controlled .cmd/.bat shims and
        // shell metacharacters must not participate in tool launching.
        shell: false,
      });

      let settled = false;
      let timer: NodeJS.Timeout;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      // Binary missing / not executable.
      child.on("error", () => done(false));
      // Died before it could settle — a TUI with no TTY, or an immediate crash.
      child.on("exit", (code) => done(code === 0));

      // Unref so a healthy child survives after we exit.
      child.unref();
      timer = setTimeout(() => done(true), settleMs);
    } catch {
      resolve(false);
    }
  });
}

function launchTool(tool: Tool, cwd: string): Promise<boolean> {
  const [cmd, args] = launchCommand(tool, cwd);
  if (!cmd) return Promise.resolve(false);
  return spawnDetached(cmd, args, cwd);
}

function launchCommand(tool: Tool, cwd: string): [string, string[]] | [null, null] {
  switch (tool) {
    case "claude-code":
      // `claude` opens in the current directory; hooks do the rest.
      return ["claude", []];
    case "claude-desktop":
      // GUI app with no reliable cross-platform CLI launcher. Handled
      // upstream by canLaunch=false, but be explicit here too.
      return [null, null];
    case "cursor":
      // `cursor <dir>` opens Cursor in that folder.
      return ["cursor", [cwd]];
    case "codex":
      return ["codex", []];
    case "gemini":
      return ["gemini", []];
    case "generic":
      return [null, null];
    default:
      return [null, null];
  }
}

// ------------- UX -------------

function printSummary(tool: Tool, autoInjected: boolean, noLaunch: boolean): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(`🔀 handoff → ${tool}`);

  if (autoInjected) {
    lines.push(`   ✓ primer will auto-inject via Claude Code's SessionStart hook`);
  } else {
    lines.push(`   ✓ primer copied to clipboard`);
  }

  if (!noLaunch) {
    lines.push(`   ✓ launching ${tool}...`);
  }

  if (!autoInjected) {
    lines.push("");
    if (tool === "claude-desktop") {
      lines.push(`   open Claude Desktop manually, start a new conversation in the`);
      lines.push(`   Project for this folder, and paste the primer as your first message.`);
    } else {
      lines.push(`   paste the primer as your first message in ${tool}.`);
    }
  }

  lines.push("");
  process.stderr.write(lines.join("\n") + "\n");
}
