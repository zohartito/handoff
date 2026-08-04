import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, dispatch, runMcpServer } from "../src/mcp/server.js";

test("MCP advertises no tools after the product freeze", () => {
  assert.deepEqual(TOOLS, []);
});

test("direct MCP dispatch refuses before handling a method or params", async () => {
  await assert.rejects(() => dispatch("tools/call", { name: "handoff_context", cwd: "/tmp/ignored" }), /permanently disabled/);
});

test("direct MCP startup refuses before connecting transport or state", async () => {
  await assert.rejects(() => runMcpServer({ cwd: "/tmp/ignored" }), /permanently disabled/);
});
