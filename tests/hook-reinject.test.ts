import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildStandingRulesContext } from "../src/commands/prime.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

const CLI = resolve(process.cwd(), "bin", "handoff.mjs");

function scaffold(withRepeatedRule: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-reinject-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(paths.task, "# Task\n\nShip the thing.\n");
  const entries = withRepeatedRule
    ? ["2026-01-01", "2026-01-02", "2026-01-03"].map(
        (d) =>
          `\n## ${d}T00:00:00Z\n\n**agent did:** used os.path\n\n**user said:** always prefer pathlib over os.path\n\n---\n`,
      )
    : [`\n## 2026-01-01T00:00:00Z\n\n**agent did:** x\n\n**user said:** a one-off note\n\n---\n`];
  writeFileSync(paths.corrections, `# Corrections\n${entries.join("")}`);
  writeFileSync(paths.attempts, "# Attempts\n");
  return dir;
}

/** Drive the real hook through the CLI so we observe actual stdout. */
function runHook(cwd: string, event: string): string {
  return execFileSync(process.execPath, [CLI, "hook", event], {
    cwd,
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd }),
  });
}

test("standing rules are re-surfaced mid-session", async () => {
  const cwd = scaffold(true);
  const ctx = await buildStandingRulesContext(resolveHandoffPaths(cwd));
  assert.match(ctx, /pathlib/);
  assert.match(ctx, /seen 3×/);
});

test("nothing durable logged yet means no mid-session context at all", async () => {
  const cwd = scaffold(false);
  const ctx = await buildStandingRulesContext(resolveHandoffPaths(cwd));
  assert.equal(ctx, "", "must be empty — this runs on every prompt, so silence is the default");
});

test("mid-session context stays small enough to run on every prompt", async () => {
  const ctx = await buildStandingRulesContext(resolveHandoffPaths(scaffold(true)));
  assert.ok(ctx.length < 600, `mid-session context too large: ${ctx.length}`);
});

test("mid-session context is phrased as information, not an instruction", async () => {
  const ctx = await buildStandingRulesContext(resolveHandoffPaths(scaffold(true)));
  // Imperative out-of-band text can trip prompt-injection defenses and get
  // surfaced to the user instead of used as context.
  assert.match(ctx, /information, not instructions/);
});

test("user-prompt-submit hook emits valid UserPromptSubmit JSON", () => {
  const out = runHook(scaffold(true), "user-prompt-submit");
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /pathlib/);
});

test("user-prompt-submit hook prints nothing when there are no standing rules", () => {
  assert.equal(runHook(scaffold(false), "user-prompt-submit").trim(), "");
});

test("user-prompt-submit hook prints nothing outside a handoff project", () => {
  const bare = mkdtempSync(join(tmpdir(), "handoff-reinject-bare-"));
  assert.equal(runHook(bare, "user-prompt-submit").trim(), "");
});
