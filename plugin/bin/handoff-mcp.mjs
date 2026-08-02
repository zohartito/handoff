#!/usr/bin/env node
/**
 * Plugin MCP shim.
 *
 * Starts `handoff mcp` for the plugin's `.mcp.json`. Same resolution order as
 * the hook shim, but the stdout discipline is stricter and the failure
 * behaviour is the opposite:
 *
 * - stdout is the JSON-RPC transport. This shim must never emit a byte of its
 *   own there — a single stray line desynchronises the client's parser. All
 *   diagnostics go to stderr.
 * - On failure it exits NON-zero. The hook shim exits 0 because a hook must
 *   never break a session; here there is no session to protect, and a server
 *   that silently does nothing is worse than one that visibly fails to start
 *   (the client surfaces it in its MCP error list).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function resolveEntry() {
  if (process.env.HANDOFF_BIN && existsSync(process.env.HANDOFF_BIN)) {
    return process.env.HANDOFF_BIN;
  }
  const bundled = join(here, "handoff.mjs");
  if (existsSync(bundled)) return bundled;

  // Only resolves under `claude --plugin-dir`; installed plugins are copied to
  // a cache where `..` no longer points at the checkout.
  const devCheckout = resolve(here, "..", "..", "bin", "handoff.mjs");
  if (existsSync(devCheckout)) return devCheckout;

  return null; // fall back to a global `handoff`
}

const entry = resolveEntry();
const projectRoot = process.env.HANDOFF_PROJECT_ROOT ?? process.cwd();
const [cmd, args] =
  entry === null
    ? ["handoff", ["mcp", "--cwd", projectRoot]]
    : [process.execPath, [entry, "mcp", "--cwd", projectRoot]];

const child = spawn(cmd, args, { stdio: "inherit", env: process.env });

child.on("error", (err) => {
  process.stderr.write(
    `[handoff-plugin] could not start the handoff MCP server (${err.message}).\n` +
      `[handoff-plugin] install it with: npm install -g @zohartito/handoff\n` +
      `[handoff-plugin] or set HANDOFF_BIN to an absolute path to bin/handoff.mjs\n`,
  );
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 0));
