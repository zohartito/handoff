import { test } from "node:test";
import assert from "node:assert/strict";
import { switchTool, spawnDetached } from "../src/commands/switch.js";

test("switchTool rejects an unknown tool with exitCode 1 before any side effects", async () => {
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const origErr = console.error;
  let stderr = "";
  console.error = (...args: unknown[]) => {
    stderr += args.join(" ") + "\n";
  };
  try {
    await switchTool({ tool: "bogus" as never, noLaunch: true });
    assert.equal(process.exitCode, 1, "exitCode set to 1 on unknown tool");
    assert.match(stderr, /unknown tool: bogus/);
    assert.match(stderr, /claude-code/, "error lists valid tools");
  } finally {
    console.error = origErr;
    process.exitCode = prevExit;
  }
});

test("switchTool does not treat 'generic' as launchable", async () => {
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const origErr = console.error;
  console.error = () => {};
  try {
    await switchTool({ tool: "generic" as never, noLaunch: true });
    assert.equal(process.exitCode, 1, "generic is prime-only, not a switch target");
  } finally {
    console.error = origErr;
    process.exitCode = prevExit;
  }
});

test("spawnDetached reports failure when the process dies immediately", async () => {
  // Regression guard: a TUI spawned detached with no TTY exits at once. The
  // old 100ms optimistic resolve claimed success anyway, so `handoff switch
  // codex` printed "launching..." and told the user to paste into a tool that
  // was already gone.
  const ok = await spawnDetached(process.execPath, ["-e", "process.exit(1)"], process.cwd(), 800);
  assert.equal(ok, false, "a process that exits non-zero must report failure");
});

test("spawnDetached reports success when the process stays up", async () => {
  const ok = await spawnDetached(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5000)"],
    process.cwd(),
    150,
  );
  assert.equal(ok, true, "a surviving process must report success");
});

test("spawnDetached reports failure when the binary does not exist", async () => {
  const ok = await spawnDetached("definitely-not-a-real-binary-xyz", [], process.cwd(), 800);
  assert.equal(ok, false);
});
