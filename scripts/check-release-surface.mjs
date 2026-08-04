#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const dist = resolve(root, "dist");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const expectedDistFiles = ["cli.js", "cli.js.map", "frozen.js", "frozen.js.map"];
const expectedPackageAllowlist = [
  "LICENSE",
  "README.md",
  "bin/handoff.mjs",
  "dist/cli.js",
  "dist/frozen.js",
];
const retiredIntegrationPaths = [
  ".claude/settings.json",
  ".claude-plugin/marketplace.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.mcp.json",
  "plugin/bin/handoff-hook.mjs",
  "plugin/bin/handoff-mcp.mjs",
  "plugin/hooks/hooks.json",
  "scripts/handoff-switch.ahk",
  "scripts/handoff-switch.applescript",
  "scripts/handoff-switch.desktop",
  "scripts/handoff-switch.sh",
  "templates/claude-commands/handoff-switch.md",
  "templates/claude-desktop-obsidian-vault-prompts.md",
  "templates/cursor/slash-handoff-switch.md",
];

function assert(condition, message) {
  if (!condition) throw new Error(`release surface refused: ${message}`);
}

assert(existsSync(dist), "dist is absent");
assert(
  JSON.stringify(readdirSync(dist).sort()) === JSON.stringify(expectedDistFiles),
  `dist must contain only ${expectedDistFiles.join(", ")}`,
);
assert(
  JSON.stringify(packageJson.files?.slice().sort()) === JSON.stringify(expectedPackageAllowlist),
  "package files allowlist changed",
);
const cli = readFileSync(resolve(dist, "cli.js"), "utf8");
assert(/\.\/frozen\.js/.test(cli), "CLI does not import the frozen boundary");
assert(!/\.\/commands\//.test(cli), "CLI imports legacy command modules");

for (const path of retiredIntegrationPaths) {
  assert(!existsSync(resolve(root, path)), `retired integration remains: ${path}`);
}

const shippedTextSurfaces = ["README.md", "plugin/README.md", "scripts/README.md", "bin/handoff.mjs"];
const retiredLaunchRegistration = /HANDOFF_BIN|CLAUDE_PLUGIN_ROOT|mcpServers|handoff\s+(?:hook|mcp|switch)|\/plugin\s+(?:install|marketplace)|claude\s+--plugin-dir/i;
for (const path of shippedTextSurfaces) {
  const contents = readFileSync(resolve(root, path), "utf8");
  assert(!retiredLaunchRegistration.test(contents), `retired launch registration remains in ${path}`);
}

console.error("release-surface-ok");
