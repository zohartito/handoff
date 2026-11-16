import { spawn } from "node:child_process";
import { platform } from "node:os";
import { resolveHandoffPaths } from "../format/paths.js";
import { exists, writeJson } from "../util/fs.js";
import {
  buildPrimer,
  buildCheckedPrimer,
  PrimerBudgetError,
  detectHandoffTaxDirection,
  type Tool,
} from "./prime.js";
import { loadMeta } from "../format/migrate.js";
import { save } from "./save.js";

type SwitchOpts = {
  tool: Tool;
  cwd?: string;
  noSave?: boolean;
  noLaunch?: boolean; // copy-only mode
  compact?: boolean; // opt in to a compact primer (strips prior trajectory)
};

/** Which primer this switch actually handed off. */
type PrimerMode = "full" | "compact";

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

  // 2. Detect handoff-tax direction (escalate / downshift / lateral).
  //    Keyed off the *departing* tool — `lastActiveTool` (stamped by prior
  //    switches), falling back to `sourceTool` (the init-time tool) on the
  //    first switch. Direction is advisory only: it drives what we suggest,
  //    never a silent primer swap. The full primer is the default so a switch
  //    NEVER silently drops continuity; the compact (lossy) primer is used only
  //    when the user explicitly opts in with --compact.
  const meta = await loadMeta(paths.meta);
  const departingTool = meta?.lastActiveTool ?? meta?.sourceTool;
  const taxDir = detectHandoffTaxDirection(departingTool, opts.tool);

  const { primer, mode: primerMode, constraintFallback } = await selectPrimer(
    paths,
    opts.tool,
    opts.compact === true,
  );

  // 3. Clipboard — skipped for claude-code (hooks auto-inject the FULL primer
  //    via `handoff hook session-start`, independent of this command). For that
  //    target the compact primer cannot be delivered through the hook, so we do
  //    not claim it was; --compact for claude-code is surfaced as a no-op below.
  const autoInjected = opts.tool === "claude-code";
  let copied = false;
  if (!autoInjected) {
    copied = await writeClipboard(primer);
    if (!copied) {
      process.exitCode = 1;
      const compactFlag = primerMode === "compact" ? " --compact" : "";
      process.stderr.write(
        "⚠  couldn't copy to clipboard automatically.\n" +
          `   run manually: handoff prime --tool ${opts.tool}${compactFlag} | ${clipCommandName()}\n`,
      );
    }
  }

  // 3b. Stamp the arriving tool as the new active tool, so the *next* switch
  //     classifies its direction against the tool actually handing off (not the
  //     immutable init-time source). Best-effort: a failed stamp must not abort
  //     a handoff that already copied/launched.
  if (meta) {
    meta.lastActiveTool = opts.tool;
    try {
      await writeJson(paths.meta, meta);
    } catch {
      /* non-fatal: direction tracking degrades to sourceTool next time */
    }
  }

  // 4. Launch the target tool (unless --no-launch).
  // Claude Desktop is a GUI app with no reliable CLI launch shim across
  // platforms, so we never attempt launch for it — the user opens it
  // manually and pastes from clipboard.
  const canLaunch = opts.tool !== "claude-desktop";
  const effectiveNoLaunch = opts.noLaunch === true || !canLaunch;
  let launched = false;
  if (!effectiveNoLaunch) {
    launched = await launchTool(opts.tool, cwd);
    if (!launched) {
      process.exitCode = 1;
      // Two common causes: the binary isn't on PATH, or it's a terminal UI that
      // will not run detached without a TTY. Report copy status separately.
      process.stderr.write(
        `⚠  couldn't launch ${opts.tool} automatically.\n` +
          `   check it's on PATH — terminal tools may also need to be opened in your own shell.\n` +
          (copied ? `   the primer is already on your clipboard: open ${opts.tool} and paste.\n` :
            `   open ${opts.tool} manually; retrieve context with handoff prime --tool ${opts.tool}.\n`),
      );
    }
  }

  // 5. Tell the user what happened — including exactly which primer was chosen
  //    and how to get the other one.
  printSummary(opts.tool, autoInjected, effectiveNoLaunch, taxDir, {
    mode: primerMode,
    requestedCompact: opts.compact === true,
    constraintFallback,
    length: primer.length,
    copied,
    launched,
  });
}

/**
 * Choose the primer to hand off. Default is the FULL primer — a switch must
 * never silently drop continuity. The compact primer is lossy by design (it
 * truncates the task, caps recent entries, and sheds to a hard budget), so it
 * is used only when the user explicitly opts in with --compact.
 *
 * Even then we refuse to lose a user *guardrail*: after building the compact
 * primer we run the same constraint check `handoff prime` uses, and if a
 * standing rule would be dropped we fall back to the full primer and report it.
 */
export async function selectPrimer(
  paths: ReturnType<typeof resolveHandoffPaths>,
  tool: Tool,
  requestedCompact: boolean,
): Promise<{ primer: string; mode: PrimerMode; constraintFallback: boolean }> {
  if (!requestedCompact) {
    return {
      primer: await buildPrimer(paths, tool, Infinity),
      mode: "full",
      constraintFallback: false,
    };
  }

  try {
    const compact = await buildCheckedPrimer(paths, tool, { mode: "compact" });
    return { primer: compact, mode: "compact", constraintFallback: false };
  } catch (err) {
    if (!(err instanceof PrimerBudgetError)) throw err;
  }

  // Compaction would have shed a user guardrail. Opt-in or not, we do not hand
  // off a primer missing a constraint — fall back to the full primer and say so.
  return {
    primer: await buildPrimer(paths, tool, Infinity),
    mode: "full",
    constraintFallback: true,
  };
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
export function spawnDetached(
  cmd: string,
  args: string[],
  cwd: string,
  settleMs: number = LAUNCH_SETTLE_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        // On Windows, GUI tools (cursor.cmd etc.) live behind .cmd shims
        // that need shell=true to resolve via PATH.
        shell: platform() === "win32",
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

function printSummary(
  tool: Tool,
  autoInjected: boolean,
  noLaunch: boolean,
  taxDir: import("./prime.js").HandoffTaxDirection,
  primer: {
    mode: PrimerMode;
    requestedCompact: boolean;
    constraintFallback: boolean;
    length: number;
    copied: boolean;
    launched: boolean;
  },
): void {
  const clip = clipCommandName();
  const lines: string[] = [];
  lines.push("");
  lines.push(`🔀 handoff → ${tool}`);

  if (autoInjected) {
    // Claude Code injects the FULL primer via its hook, regardless of --compact.
    lines.push(`   ✓ full primer will auto-inject via Claude Code's SessionStart hook`);
    if (primer.requestedCompact) {
      lines.push(
        `   ℹ  --compact does not apply to Claude Code (its hook injects the full primer).`,
      );
      lines.push(`      For a compact context: handoff prime --tool ${tool} --compact`);
    }
  } else if (!primer.copied) {
    lines.push(`   ⚠ primer was not copied; run handoff prime --tool ${tool} to retrieve it.`);
  } else if (primer.mode === "compact") {
    lines.push(
      `   ✓ compact primer copied to clipboard (${primer.length} chars — prior trajectory stripped)`,
    );
    lines.push(`      Full primer: handoff prime --tool ${tool} | ${clip}`);
  } else {
    lines.push(`   ✓ full primer copied to clipboard (${primer.length} chars)`);
  }

  // If --compact was asked for but a user guardrail would have been dropped, we
  // used the full primer instead — never silently. Say so.
  if (primer.constraintFallback) {
    lines.push(
      `   ⚠  --compact skipped: the compact primer would have dropped a user constraint,`,
    );
    lines.push(`      so the full primer was used to preserve it.`);
  }

  if (!noLaunch && primer.launched) {
    lines.push(`   ✓ launching ${tool}...`);
  }

  // Escalation is advisory only: point the user at the explicit compact option
  // rather than compacting for them. Nothing here has been dropped.
  if (taxDir === "escalate" && primer.mode === "full" && !primer.requestedCompact) {
    lines.push(
      `   ℹ  Handoff tax: escalating to a more capable ${tool} — full primer used by default.`,
    );
    if (autoInjected) {
      lines.push(`      To hand off a compact primer instead: handoff prime --tool ${tool} --compact`);
    } else {
      lines.push(
        `      To strip the prior trajectory: handoff switch ${tool} --compact` +
          `  (or: handoff prime --tool ${tool} --compact | ${clip})`,
      );
    }
  }

  if (!autoInjected && primer.copied) {
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
