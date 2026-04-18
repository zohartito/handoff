import { spawn } from "node:child_process";
import { platform } from "node:os";
import { resolveHandoffPaths } from "../format/paths.js";
import { exists } from "../util/fs.js";
import { buildPrimer, type Tool } from "./prime.js";
import { save } from "./save.js";

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
export async function switchTool(opts: SwitchOpts): Promise<void> {
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
      process.stderr.write(
        `⚠  couldn't launch ${opts.tool} automatically.\n` +
          `   is it installed and on PATH?\n`,
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

function tryOneClip(cmd: string, args: string[], content: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
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
function launchTool(tool: Tool, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [cmd, args] = launchCommand(tool, cwd);
    if (!cmd) {
      resolve(false);
      return;
    }
    try {
      const child = spawn(cmd, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        // On Windows, GUI tools (cursor.cmd etc.) live behind .cmd shims
        // that need shell=true to resolve via PATH.
        shell: platform() === "win32",
      });
      child.on("error", () => resolve(false));
      // Unref so the child survives after the parent exits.
      child.unref();
      // Give it a tick to fail fast if the binary is missing.
      setTimeout(() => resolve(true), 100);
    } catch {
      resolve(false);
    }
  });
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
