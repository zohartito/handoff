#!/usr/bin/env node
import { Command } from "commander";
import { frozenFeatureError, manualUninstallGuide } from "./frozen.js";

const VERSION = "0.9.2";
const DISABLED_COMMANDS = [
  "init", "status", "save", "attempt", "decide", "correct", "capture",
  "prime", "install", "doctor", "hook", "switch", "ingest", "obsidian",
  "search", "patterns", "verify", "mcp", "evaluate", "sync",
] as const;

const program = new Command()
  .name("handoff")
  .description("Frozen; only manual removal guidance is available")
  .version(VERSION);

for (const name of DISABLED_COMMANDS) {
  program
    .command(name, { hidden: true })
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      throw frozenFeatureError(`handoff ${name}`);
    });
}

program
  .command("uninstall")
  .description("print manual removal guidance; does not modify files")
  .requiredOption("--tool <tool>", "claude-code | claude-desktop | cursor | codex")
  .action((opts: { tool: string }) => {
    const guide = manualUninstallGuide(opts.tool);
    if (!guide) {
      throw new Error("unknown tool: expected claude-code, claude-desktop, cursor, or codex");
    }
    process.stdout.write(`${guide}\n`);
  });

await program.parseAsync(process.argv);
