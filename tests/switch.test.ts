import { test } from "node:test";
import assert from "node:assert/strict";
import { switchTool } from "../src/commands/switch.js";

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
