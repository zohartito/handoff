import { manualUninstallGuide } from "../frozen.js";

/**
 * Compatibility API retained only to print the non-mutating removal checklist.
 * It never opens, edits, or deletes project state.
 */
export async function uninstall(opts: { tool: string }): Promise<void> {
  const guide = manualUninstallGuide(opts.tool);
  if (!guide) throw new Error("unknown tool: expected claude-code, claude-desktop, cursor, or codex");
  process.stdout.write(`${guide}\n`);
}
