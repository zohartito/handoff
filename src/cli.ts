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
import { save } from "./commands/save.js";
import { prime } from "./commands/prime.js";
import { install } from "./commands/install.js";
import { uninstall } from "./commands/uninstall.js";
import { hook } from "./commands/hook.js";
import { ingest } from "./commands/ingest.js";
import { switchTool } from "./commands/switch.js";
import { doctor } from "./commands/doctor.js";
import { obsidian } from "./commands/obsidian.js";
import { search } from "./commands/search.js";
import { patterns } from "./commands/patterns.js";

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
  .action(async (choice, opts) => {
    await decide({
      choice,
      because: opts.because,
      alternatives: opts.alt,
    });
  });

program
  .command("correct <action>")
  .description("log a time the agent got it wrong and what the user meant")
  .requiredOption("--user-said <text>", "verbatim user feedback")
  .option("--lesson <text>", "extracted rule for the future")
  .action(async (action, opts) => {
    await correct({
      action,
      userSaid: opts.userSaid,
      lesson: opts.lesson,
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
  .description("internal: runs from a Claude Code hook (session-start | stop | rate-limit)")
  .action(async (event) => {
    await hook({ event });
  });

program
  .command("switch <tool>")
  .description("hand off to another tool: save + prime + clipboard + launch (tool: claude-code | claude-desktop | cursor | codex | gemini)")
  .option("--no-save", "skip `handoff save` before switching")
  .option("--no-launch", "copy primer to clipboard but don't launch the tool")
  .action(async (tool, opts) => {
    await switchTool({
      tool,
      noSave: opts.save === false,
      noLaunch: opts.launch === false,
    });
  });

program
  .command("ingest")
  .description("read a past AI-agent session and emit a structured summary for populating .handoff/")
  .option("--from <tool>", "source tool (claude-code | cursor | codex | gemini)")
  .option("--all", "ingest the most recent session from every source and concatenate")
  .option("--session <id>", "session id (or 'latest')", "latest")
  .option("--list", "list recent sessions instead of ingesting")
  .option("--out <path>", "write to file instead of stdout")
  .option("--project <path>", "project path to scope session discovery (default: cwd)")
  .action(async (opts) => {
    await ingest({
      from: opts.from,
      all: opts.all,
      session: opts.session,
      list: opts.list,
      out: opts.out,
      project: opts.project,
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

await program.parseAsync(process.argv);
