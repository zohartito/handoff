#!/usr/bin/env node
/**
 * Plugin hook shim.
 *
 * Claude Code invokes this for every handoff hook event. Its whole job is to
 * find a usable `handoff` and forward the event to it, with three properties
 * that matter more than anything it does:
 *
 * 1. stdout is sacred. SessionStart and UserPromptSubmit read the child's
 *    stdout as injected context, so this shim writes NOTHING to stdout itself —
 *    it only passes the child's through. Every diagnostic goes to stderr.
 * 2. stdin is forwarded. Stop and PreCompact receive a JSON payload there
 *    (transcript_path, session_id, stop_hook_active) and auto-capture needs it.
 * 3. It never fails the session. A missing binary or a crashed child exits 0
 *    with a loud stderr message. Exit code 2 in particular would *block* the
 *    event, which is never the right outcome for a context tool.
 *
 * Resolution is explicit and reported, because the failure this plugin exists
 * to fix was a silent one: hooks configured but pointing at nothing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const event = process.argv[2];
if (!event) {
  process.stderr.write("[handoff-plugin] no hook event given\n");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate entry points, best first.
 *
 * A bundled copy inside the plugin wins because it cannot drift from the
 * plugin. The repo-relative path only resolves in `--plugin-dir` development
 * mode (installed plugins are copied to a cache, so `..` no longer points at
 * the checkout) — it is a convenience, not the shipping path.
 */
function resolveEntry() {
  if (process.env.HANDOFF_BIN && existsSync(process.env.HANDOFF_BIN)) {
    return { kind: "env", path: process.env.HANDOFF_BIN };
  }
  const bundled = join(here, "handoff.mjs");
  if (existsSync(bundled)) return { kind: "bundled", path: bundled };

  const devCheckout = resolve(here, "..", "..", "bin", "handoff.mjs");
  if (existsSync(devCheckout)) return { kind: "dev-checkout", path: devCheckout };

  return { kind: "path", path: null }; // fall back to a global `handoff`
}

const entry = resolveEntry();
const [cmd, args] =
  entry.path === null
    ? ["handoff", ["hook", event]]
    : [process.execPath, [entry.path, "hook", event]];

const child = spawn(cmd, args, {
  // stdin piped through so Stop/PreCompact payloads reach auto-capture;
  // stdout inherited so injected context is passed through untouched.
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});

child.on("error", (err) => {
  const why =
    entry.path === null
      ? "no `handoff` on PATH and no copy bundled in the plugin"
      : `could not run ${entry.path}`;
  process.stderr.write(
    `[handoff-plugin] ${why} (${err.message}).\n` +
      `[handoff-plugin] install it with: npm install -g @zohartito/handoff\n` +
      `[handoff-plugin] or set HANDOFF_BIN to an absolute path to bin/handoff.mjs\n`,
  );
  process.exit(0); // never break the session
});

child.on("exit", () => process.exit(0));
