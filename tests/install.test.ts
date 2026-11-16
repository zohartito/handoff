import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install } from "../src/commands/install.js";

/**
 * Capture console.log output from an async function that prints to stdout.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

test("`handoff install --tool claude-code` output references the slash-command template", async () => {
  const out = await captureStdout(() => install({ tool: "claude-code" }));

  // The install output must point at the slash-command template path so the
  // user knows how to wire up `/handoff-switch` inside a Claude Code session.
  assert.match(
    out,
    /templates\/claude-commands\/handoff-switch\.md/,
    "expected install output to reference templates/claude-commands/handoff-switch.md",
  );
  assert.match(
    out,
    /\/handoff-switch/,
    "expected install output to mention the /handoff-switch slash command",
  );
});

test("`handoff install --tool cursor` output references the cursor handoff-switch template", async () => {
  const out = await captureStdout(() => install({ tool: "cursor" }));

  assert.match(
    out,
    /templates\/cursor\/slash-handoff-switch\.md/,
    "expected install output to reference templates/cursor/slash-handoff-switch.md",
  );
});

test("`handoff install --tool claude-desktop` output explains the manual Project-based setup", async () => {
  const out = await captureStdout(() => install({ tool: "claude-desktop" }));

  // A Claude Desktop "Project" is the persistence unit we lean on, so the
  // install instructions must tell the user to create one.
  assert.match(out, /Project/, "expected install output to reference Claude Desktop Projects");
  // Filesystem MCP is one of the two documented access modes.
  assert.match(out, /filesystem MCP/i);
  // The suggested clipboard-paste workflow uses `handoff prime --tool claude-desktop`.
  assert.match(out, /handoff prime --tool claude-desktop/);
  // It should warn that there's no hook / automated integration.
  assert.match(out, /no hook system/i);
});

test("`handoff install --tool claude-desktop` mentions Obsidian MCP as an optional enhancement", async () => {
  const out = await captureStdout(() => install({ tool: "claude-desktop" }));
  // Obsidian MCP is an optional bonus — not mandatory, but called out
  // because `handoff obsidian sync` composes with it.
  assert.match(out, /Obsidian/);
});

test("HOF-27: removal and doctor recognize optional handoff hooks", async () => {
  const { uninstall } = await import("../src/commands/uninstall.js");
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const installed = await captureStdout(() => install({ tool: "claude-code" }));
  const removal = await captureStdout(() => uninstall({ tool: "claude-code" }));
  for (const command of installed.match(/handoff hook [a-z-]+/g) ?? []) assert.ok(removal.includes(command), command);
  assert.match(removal, /handoff hook user-prompt-submit/);
  const root = await mkdtemp(join(tmpdir(), "handoff-hook-removal-"));
  await mkdir(join(root, ".claude"));
  await writeFile(join(root, ".claude/settings.json"), JSON.stringify({
    hooks: { PreCompact: [{ hooks: [{ type: "command", command: "handoff hook pre-compact" }] }] },
  }));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "doctor"], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root } });
  assert.match(result.stdout, /PreCompact/);
  assert.doesNotMatch(result.stdout, /project \(\.claude\/settings.json\): no handoff hooks/);
});
