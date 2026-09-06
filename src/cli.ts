#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { attempt } from "./commands/attempt.js";
import { decide } from "./commands/decide.js";
import { correct } from "./commands/correct.js";
import { capture } from "./commands/capture.js";
import { save } from "./commands/save.js";
import { prime } from "./commands/prime.js";
import { install } from "./commands/install.js";
import { uninstall } from "./commands/uninstall.js";
import { hook, type HookPayload } from "./commands/hook.js";
import { ingest } from "./commands/ingest.js";
import { switchTool } from "./commands/switch.js";
import { doctor } from "./commands/doctor.js";
import { obsidian } from "./commands/obsidian.js";
import { search } from "./commands/search.js";
import { patterns } from "./commands/patterns.js";
import { verify } from "./commands/verify.js";
import { runMcpServer } from "./mcp/server.js";
import { evaluate } from "./commands/evaluate.js";
import { compact, isCompactTarget, type CompactTarget } from "./commands/compact.js";

/**
 * Read + parse the JSON payload Claude Code pipes to a hook on stdin. Returns
 * `{}` on anything unexpected (TTY, empty, malformed) so the hook never hangs
 * or throws just because there's no payload.
 */
async function readHookPayload(): Promise<HookPayload> {
  try {
    if (process.stdin.isTTY) return {};
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
}

const program = new Command();

const pkgVersion = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

program
  .name("handoff")
  .description("Portable agent state across AI coding tools")
  .version(pkgVersion);

program
  .command("init")
  .description("scaffold .handoff/ in the current project")
  .option("--from <tool>", "source tool (claude-code, cursor, codex, gemini, unknown)")
  .option("--force", "overwrite existing .handoff/")
  .action(async (opts) => {
    await init({ from: opts.from, force: opts.force });
  });

program
  .command("status")
  .description("show what's populated in .handoff/")
  .action(async () => {
    await status();
  });

program
  .command("save")
  .description("refresh auto-collected state (git, env, etc.)")
  .action(async () => {
    await save();
  });

program
  .command("attempt <what>")
  .description("log a failed approach with its error trace")
  .option("--error <trace>", "verbatim error output")
  .option("--fix <desc>", "what ended up working")
  .option("--summary <text>", "agent-written summary (don't replace the trace)")
  .action(async (what, opts) => {
    await attempt({
      what,
      error: opts.error,
      fix: opts.fix,
      summary: opts.summary,
    });
  });

program
  .command("decide <choice>")
  .description("log a key decision with its reasoning")
  .option("--because <reason>", "why this choice")
  .option("--alt <alternatives...>", "alternatives considered")
  .option(
    "--key <key>",
    "fact key: a newer entry with the same key revokes the older one (kept for audit)",
  )
  .action(async (choice, opts) => {
    await decide({
      choice,
      because: opts.because,
      alternatives: opts.alt,
      key: opts.key,
    });
  });

program
  .command("correct <action>")
  .description("log a time the agent got it wrong and what the user meant")
  .requiredOption("--user-said <text>", "verbatim user feedback")
  .option("--lesson <text>", "extracted rule for the future")
  .option(
    "--key <key>",
    "fact key: a newer entry with the same key revokes the older one (kept for audit)",
  )
  .action(async (action, opts) => {
    await correct({
      action,
      userSaid: opts.userSaid,
      lesson: opts.lesson,
      key: opts.key,
    });
  });

program
  .command("capture")
  .description("dump an end-of-session transcript (AI-runnable) + extract markers")
  .option("--from <source>", "input source: 'stdin' or 'file'")
  .option("--file <path>", "path to transcript file (when --from file)")
  .option("--mode <mode>", "'full' (default) or 'summary'", "full")
  .option("--task <file>", "override target for extracted TASK: lines")
  .option("--decisions <file>", "override target for extracted DECISION: lines")
  .option("--corrections <file>", "override target for extracted CORRECTION: lines")
  .action(async (opts) => {
    const mode = opts.mode === "summary" ? "summary" : "full";
    if (opts.mode && opts.mode !== "full" && opts.mode !== "summary") {
      console.error(`capture: invalid --mode '${opts.mode}' (use 'full' or 'summary')`);
      process.exitCode = 1;
      return;
    }
    const fromStdin = opts.from === "stdin";
    const fromFile = opts.from === "file";
    if (opts.from && !fromStdin && !fromFile) {
      console.error(`capture: invalid --from '${opts.from}' (use 'stdin' or 'file')`);
      process.exitCode = 1;
      return;
    }
    if (fromStdin && opts.file) {
      console.error("capture: --from stdin cannot be combined with --file");
      process.exitCode = 1;
      return;
    }
    if (fromFile && !opts.file) {
      console.error("capture: --from file requires --file <path>");
      process.exitCode = 1;
      return;
    }
    if (!opts.from && !opts.file) {
      console.error("capture: specify --from stdin or --from file --file <path>");
      process.exitCode = 1;
      return;
    }
    const source = fromFile || opts.file
      ? ({ kind: "file", path: opts.file } as const)
      : ({ kind: "stdin" } as const);
    await capture({
      source,
      mode,
      taskPath: opts.task,
      decisionsPath: opts.decisions,
      correctionsPath: opts.corrections,
    });
  });

program
  .command("prime")
  .description("emit a primer prompt for a target tool")
  .option("--tool <tool>", "target tool (claude-code, claude-desktop, cursor, codex, gemini, generic)", "generic")
  .option("--max-chars <n>", "truncate to fit", (v) => parseInt(v, 10))
  .option("--compact", "emit a task-focused primer (< 2k chars) instead of the full artifact")
  .option("--subagent", "emit a subagent primer (for Claude Code task-subagents; ~1.5k chars, no writes)")
  .action(async (opts) => {
    await prime({
      tool: opts.tool,
      maxChars: opts.maxChars,
      compact: opts.compact,
      subagent: opts.subagent,
    });
  });

program
  .command("install")
  .description("print integration instructions for a tool (claude-code, claude-desktop, cursor)")
  .requiredOption("--tool <tool>", "claude-code | claude-desktop | cursor")
  .action(async (opts) => {
    await install({ tool: opts.tool });
  });

program
  .command("uninstall")
  .description("print removal instructions for a tool (claude-code, claude-desktop, cursor)")
  .requiredOption("--tool <tool>", "claude-code | claude-desktop | cursor")
  .action(async (opts) => {
    await uninstall({ tool: opts.tool });
  });

program
  .command("doctor")
  .description("scan the current project + global install for common issues")
  .action(async () => {
    await doctor();
  });

program
  .command("hook <event>")
  .description(
    "internal: runs from a Claude Code hook (session-start | user-prompt-submit | stop | pre-compact | rate-limit)",
  )
  .action(async (event) => {
    const payload = await readHookPayload();
    await hook({ event, payload });
  });

program
  .command("switch <tool>")
  .description("hand off to another tool: save + prime + clipboard + launch (tool: claude-code | claude-desktop | cursor | codex | gemini)")
  .option("--no-save", "skip `handoff save` before switching")
  .option("--no-launch", "copy primer to clipboard but don't launch the tool")
  .option("--compact", "hand off a compact primer (strips the prior trajectory; lossy — opt-in)")
  .action(async (tool, opts) => {
    await switchTool({
      tool,
      noSave: opts.save === false,
      noLaunch: opts.launch === false,
      compact: opts.compact === true,
    });
  });

program
  .command("ingest")
  .description("read a past AI-agent session and emit a structured summary for populating .handoff/")
  .option("--from <tool>", "source tool (claude-code | cursor | codex | gemini | paste)")
  .option("--all", "ingest the most recent session from every source and concatenate")
  .option("--session <id>", "session id (or 'latest')", "latest")
  .option("--list", "list recent sessions instead of ingesting")
  .option("--out <path>", "write to file instead of stdout")
  .option("--project <path>", "project path to scope session discovery (default: cwd)")
  .option("--file <path>", "(--from paste) read transcript from file")
  .option("--stdin", "(--from paste) read transcript from stdin")
  .option("--clipboard", "(--from paste) read transcript from system clipboard")
  .action(async (opts) => {
    await ingest({
      from: opts.from,
      all: opts.all,
      session: opts.session,
      list: opts.list,
      out: opts.out,
      project: opts.project,
      file: opts.file,
      stdin: opts.stdin,
      clipboard: opts.clipboard,
    });
  });

const obsidianCmd = program
  .command("obsidian")
  .description("sync .handoff/ state into an Obsidian vault (permanent memory across projects)");

obsidianCmd
  .command("sync")
  .description("write Daily/Decisions/Rules notes from the current project's .handoff/ into the vault")
  .option("--vault <path>", "vault path (falls back to HANDOFF_OBSIDIAN_VAULT)")
  .option("--project <path>", "project path (default: cwd)")
  .action(async (opts) => {
    try {
      await obsidian({ vault: opts.vault, project: opts.project });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command("search <query>")
  .description("search every .handoff/ folder on this machine for a string")
  .option("--limit <n>", "max results (default: 20)", (v) => parseInt(v, 10))
  .option("--root <path>", "override search root (repeatable)", (v, acc: string[]) => acc.concat([v]), [] as string[])
  .option("--case-sensitive", "exact-case match")
  .action(async (query, opts) => {
    await search(query, {
      roots: opts.root && opts.root.length > 0 ? opts.root : undefined,
      limit: opts.limit,
      caseSensitive: opts.caseSensitive,
    });
  });

program
  .command("patterns")
  .description("scan every .handoff/ on this machine and report cross-project themes")
  .option("--top <n>", "top-N correction themes to show (default 20)", (v) => parseInt(v, 10))
  .option("--root <path>", "override search root (repeatable)", (v, acc: string[]) => acc.concat(v), [] as string[])
  .action(async (opts) => {
    await patterns({
      top: Number.isFinite(opts.top) ? opts.top : undefined,
      roots: opts.root && opts.root.length > 0 ? opts.root : undefined,
    });
  });

program
  .command("verify")
  .description("check whether a receiving agent actually picked up the handoff")
  .option("--check", "score a restatement instead of printing the prompt")
  .option("--file <path>", "read the restatement from a file (implies --check)")
  .option("--stdin", "read the restatement from stdin (implies --check)")
  .action(async (opts) => {
    await verify({
      check: !!(opts.check || opts.file || opts.stdin),
      file: opts.file,
    });
  });

program
  .command("mcp")
  .description(
    "run an MCP (Model Context Protocol) server over stdio so any MCP-speaking agent (Codex, Cursor, Claude Desktop, Kimi Code) can read + write handoff state natively",
  )
  .option(
    "--cwd <path>",
    "project root to operate on (default: HANDOFF_PROJECT_ROOT env var, else cwd)",
  )
  .action(async (opts) => {
    const cwd = opts.cwd ?? process.env.HANDOFF_PROJECT_ROOT ?? process.cwd();
    await runMcpServer({ cwd, version: pkgVersion });
  });

program
  .command("compact [target]")
  .description(
    "dedupe + archive the append-only logs (attempts | corrections | decisions | all) so they stop growing without bound",
  )
  .option("--keep <n>", "distinct live entries to keep above the archive fold (default 20)", (v) => parseInt(v, 10))
  .option("--dry-run", "report what would change without writing")
  .action(async (target, opts) => {
    let targets: CompactTarget[] | undefined;
    if (target && target !== "all") {
      if (!isCompactTarget(target)) {
        console.error(`compact: invalid target '${target}' (use attempts | corrections | decisions | all)`);
        process.exitCode = 1;
        return;
      }
      targets = [target];
    }
    await compact({
      targets,
      keep: Number.isFinite(opts.keep) ? opts.keep : undefined,
      dryRun: !!opts.dryRun,
    });
  });

program
  .command("evaluate")
  .description("score the correction/attempt ranking on a labelled retrieval eval (dev tool)")
  .option("--strategy <name>", "run a single strategy (recurrence | recency)")
  .option("--compare", "run every strategy side by side with the per-metric winner")
  .option("--sweep", "sweep PROMOTION_THRESHOLD (2..6) and report F1 for each")
  .option("--json", "emit machine-readable JSON instead of a table")
  .option("--k <n>", "retrieval cutoff, overriding each scenario's own k", (v) => parseInt(v, 10))
  .option("--dir <path>", "eval fixtures directory (default: tests/fixtures/eval)")
  .action(async (opts) => {
    await evaluate({
      strategy: opts.strategy,
      compare: !!opts.compare,
      sweep: !!opts.sweep,
      json: !!opts.json,
      k: Number.isFinite(opts.k) ? opts.k : undefined,
      dir: opts.dir,
    });
  });

await program.parseAsync(process.argv);
