#!/usr/bin/env node
/**
 * Build the only distributable Handoff surface.
 *
 * This deliberately clears dist before checking for the compiler. A failed
 * build therefore cannot leave an old operational artifact for npm pack.
 */
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const dist = resolve(root, "dist");
const compiler = resolve(root, "node_modules", "typescript", "bin", "tsc");
const checker = resolve(root, "scripts", "check-release-surface.mjs");

function fail(message, result) {
  rmSync(dist, { recursive: true, force: true });
  console.error(`release build refused: ${message}`);
  process.exit(result?.status ?? 1);
}

rmSync(dist, { recursive: true, force: true });

if (!existsSync(compiler)) {
  fail("local TypeScript dependency is unavailable; refusing to pack stale artifacts");
}

const compile = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
});
if (compile.error || compile.status !== 0) {
  fail("the frozen release build failed", compile);
}

const check = spawnSync(process.execPath, [checker], { cwd: root, stdio: "inherit" });
if (check.error || check.status !== 0) {
  fail("release-surface safety check failed", check);
}
