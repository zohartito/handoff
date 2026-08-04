/**
 * Public, side-effect-free surface retained after the product freeze.
 *
 * This module intentionally does not inspect environment variables, paths, or
 * configuration.  It is the only library entry point included in the package.
 */
export const PRODUCT_FREEZE_MESSAGE =
  "handoff is permanently disabled: this release cannot safely access repository or session state with the filesystem primitives available in Node.";

export const MANUAL_UNINSTALL_GUIDES = {
  "claude-code": `# Remove Handoff from Claude Code

This command makes no changes. Preserve any existing .handoff data; it may contain historical work records.

For every configuration file below, first create a same-directory backup (for example, an editor-created ".handoff-freeze-backup" copy). Edit only the named Handoff records, validate the resulting JSON, then use an editor or config tool that writes by safe-save/atomic replacement. Do not use recursive deletion commands.

1. In both ~/.claude/settings.json and .claude/settings.json, remove every hook object whose command mentions handoff or handoff-hook. Check all event arrays, including SessionStart, UserPromptSubmit, Stop, StopFailure, PreCompact, and any custom event names.
2. Remove Handoff MCP server entries from Claude Code configuration, including mcpServers entries, command arrays, and environment blocks that launch handoff.
3. If Handoff was installed as a Claude Code plugin or via a marketplace, remove its enabled plugin record and marketplace source/entry through Claude Code's plugin/marketplace UI or its documented plugin removal command. Also remove project-local plugin manifests or command registrations that launch handoff.
4. Remove Handoff instructions from CLAUDE.md and ~/.claude/CLAUDE.md, including references to .handoff, handoff prime, or handoff hook.
5. Remove shell aliases, wrapper scripts, launchers, and task-runner entries that invoke handoff.

Do not run handoff doctor: it is permanently disabled. This tool does not delete .handoff data.`,
  "claude-desktop": `# Remove Handoff from Claude Desktop

This command makes no changes. Preserve any existing .handoff data.

For every configuration file you edit, first make a same-directory backup, remove only Handoff records, validate its JSON, then use safe-save/atomic replacement. Do not use recursive deletion commands.

1. Remove Handoff custom-instruction blocks and project attachments that mention .handoff or handoff commands.
2. Remove every Handoff MCP server/configuration entry, including mcpServers records, command definitions, and environment variables used to launch it.
3. Remove copied primers, shell aliases, wrappers, task entries, or launchers that invoke handoff.

Do not run handoff doctor: it is permanently disabled. This tool does not delete .handoff data.`,
  cursor: `# Remove Handoff from Cursor

This command makes no changes. Preserve any existing .handoff data.

For every user or workspace configuration file you edit, first make a same-directory backup, remove only Handoff records, validate its JSON, then use safe-save/atomic replacement. Do not use recursive deletion commands.

1. Remove Handoff text from .cursorrules, project rules, workspace instructions, and saved command templates.
2. Remove every Handoff MCP/server integration from Cursor user and workspace configuration, including mcpServers records, launch commands, and environment variables.
3. Remove shell aliases, tasks, wrappers, and launchers that invoke handoff.

Do not run handoff doctor: it is permanently disabled. This tool does not delete .handoff data.`,
  codex: `# Remove Handoff from Codex

This command makes no changes. Preserve any existing .handoff data.

Before editing ~/.codex/config.toml, create a same-directory backup. Remove only Handoff MCP/server records, command launchers, and environment entries; then validate TOML and use a safe-save/atomic replacement. Do not use recursive deletion commands.

1. In ~/.codex/config.toml, remove every Handoff MCP/server configuration, including server tables, command values, arguments, and environment blocks that launch handoff or reference .handoff.
2. Remove Handoff instructions, copied primers, aliases, wrappers, shell functions, task entries, and launchers that invoke handoff.
3. If another Codex user/workspace configuration contains an Handoff MCP registration, follow the same backup, precise-edit, validate, and atomic-save procedure there.

Do not run handoff doctor: it is permanently disabled. This tool does not delete .handoff data.`,
} as const;

export type SupportedUninstallTool = keyof typeof MANUAL_UNINSTALL_GUIDES;

export function manualUninstallGuide(tool: string): string | null {
  return Object.hasOwn(MANUAL_UNINSTALL_GUIDES, tool)
    ? MANUAL_UNINSTALL_GUIDES[tool as SupportedUninstallTool]
    : null;
}

export function frozenFeatureError(feature: string): Error {
  return new Error(`${PRODUCT_FREEZE_MESSAGE} ${feature} is unavailable. Only --help, --version, and manual uninstall guidance remain.`);
}
