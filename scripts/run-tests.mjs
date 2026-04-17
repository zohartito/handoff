#!/usr/bin/env node
// Enumerate compiled test files and hand them to `node --test`.
// Works across node 20 (no glob) + node 22+ (has glob) + every shell.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = "dist-test/tests";
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`no test files found in ${dir}/`);
  process.exit(1);
}

const watch = process.argv.includes("--watch");
const args = ["--test", ...(watch ? ["--watch"] : []), ...files];
const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
