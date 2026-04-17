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
