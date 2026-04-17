#!/usr/bin/env node
import { Command } from "commander";
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

const program = new Command();

program
  .name("handoff")
  .description("Portable agent state across AI coding tools")
  .version("0.1.0");

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
  .option("--tool <tool>", "target tool (claude-code, cursor, codex, gemini, generic)", "generic")
  .option("--max-chars <n>", "truncate to fit", (v) => parseInt(v, 10))
  .option("--compact", "emit a task-focused primer (< 2k chars) instead of the full artifact")
  .action(async (opts) => {
    await prime({
      tool: opts.tool,
      maxChars: opts.maxChars,
      compact: opts.compact,
    });
  });

program
  .command("install")
  .description("print integration instructions for a tool (claude-code, cursor)")
  .requiredOption("--tool <tool>", "claude-code | cursor")
  .action(async (opts) => {
    await install({ tool: opts.tool });
  });

program
  .command("uninstall")
  .description("print removal instructions for a tool (claude-code, cursor)")
  .requiredOption("--tool <tool>", "claude-code | cursor")
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
  .description("hand off to another tool: save + prime + clipboard + launch (tool: claude-code | cursor | codex | gemini)")
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

await program.parseAsync(process.argv);
