import { test } from "node:test";
import assert from "node:assert/strict";
import { install } from "../src/commands/install.js";

for (const tool of ["claude-code", "claude-desktop", "cursor"]) {
  test(`direct install import refuses for ${tool}`, async () => {
    await assert.rejects(() => install({ tool }), /permanently disabled/);
  });
}

test("direct install import refuses unknown tools before doing any work", async () => {
  await assert.rejects(() => install({ tool: "unknown" }), /permanently disabled/);
});
