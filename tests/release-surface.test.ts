import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const BUILD_RELEASE = join(ROOT, "scripts", "build-release.mjs");

function packDryRun(): string[] {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "npm test must provide npm_execpath for lifecycle verification");
  const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
  return packed[0].files.map((file) => file.path).sort();
}

function assertFrozenDist(): void {
  assert.deepEqual(readdirSync(DIST).sort(), [
    "cli.js",
    "cli.js.map",
    "frozen.js",
    "frozen.js.map",
  ]);
  assert.equal(existsSync(join(DIST, "commands")), false);
  assert.equal(existsSync(join(DIST, "adapters")), false);
  assert.equal(existsSync(join(DIST, "mcp")), false);
  assert.equal(existsSync(join(DIST, "util")), false);

  const cli = readFileSync(join(DIST, "cli.js"), "utf8");
  assert.match(cli, /\.\/frozen\.js/);
  assert.doesNotMatch(cli, /\.\/commands\//);
}

test("release build contains only the frozen command and library boundary", () => {
  assertFrozenDist();
});

test("workflow definitions contain no action invocation or granted token permission", () => {
  for (const file of ["ci.yml", "secret-scan.yml", "claude-pr-review.yml"]) {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", file), "utf8");
    assert.doesNotMatch(workflow, /^\s*-?\s*uses\s*:/m, file);
    assert.match(workflow, /^permissions:\s*\{\}\s*$/m, file);
    assert.match(workflow, /disabled.*pending.*reviewed immutable action pin/i, file);
  }
});

test("prepack removes deliberately stale operational artifacts before dry-run packaging", () => {
  const staleMarker = "STALE-OPERATIONAL-ARTIFACT-MUST-NOT-PACK";
  mkdirSync(join(DIST, "commands"), { recursive: true });
  writeFileSync(join(DIST, "commands", "obsidian.js"), staleMarker);
  writeFileSync(join(DIST, "cli.js"), staleMarker);

  const files = packDryRun();
  assert.deepEqual(files, [
    "LICENSE",
    "README.md",
    "bin/handoff.mjs",
    "dist/cli.js",
    "dist/frozen.js",
    "package.json",
  ]);
  assertFrozenDist();
  assert.doesNotMatch(readFileSync(join(DIST, "cli.js"), "utf8"), new RegExp(staleMarker));
});

test("prepack builds a safe executable from a checkout with no dist directory", () => {
  rmSync(DIST, { recursive: true, force: true });
  assert.equal(existsSync(DIST), false);

  packDryRun();
  assertFrozenDist();
  assert.match(readFileSync(join(ROOT, "bin", "handoff.mjs"), "utf8"), /dist\/cli\.js/);
});

test("release build fails closed and removes stale dist when local dependencies are absent", () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-release-build-no-deps-"));
  const scripts = join(root, "scripts");
  const stale = join(root, "dist", "commands", "legacy.js");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, "dist", "commands"), { recursive: true });
  copyFileSync(BUILD_RELEASE, join(scripts, "build-release.mjs"));
  writeFileSync(stale, "STALE-OPERATIONAL-ARTIFACT-MUST-NOT-SURVIVE");
  try {
    const result = spawnSync(process.execPath, [join(scripts, "build-release.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local TypeScript dependency is unavailable/);
    assert.equal(existsSync(join(root, "dist")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retired source integrations and launch registrations are absent", () => {
  for (const path of [
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
  ]) {
    assert.equal(existsSync(join(ROOT, path)), false, path);
  }

  for (const path of ["README.md", "plugin/README.md", "scripts/README.md"]) {
    const source = readFileSync(join(ROOT, path), "utf8");
    assert.doesNotMatch(
      source,
      /HANDOFF_BIN|CLAUDE_PLUGIN_ROOT|mcpServers|handoff\s+(?:hook|mcp|switch)|\/plugin\s+(?:install|marketplace)|claude\s+--plugin-dir/i,
      path,
    );
  }
});
