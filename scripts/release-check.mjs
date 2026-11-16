#!/usr/bin/env node
// HOF-01: check the built distribution, including an unpacked npm tarball.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.argv[2] ?? ".");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const cli = join(root, "bin/handoff.mjs");
const cwd = mkdtempSync(join(tmpdir(), "handoff-release-"));
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `built command failed: ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}
assert.equal(run(["--version"]).trim(), pkg.version);
const commands = [...readme.matchAll(/^### `handoff (\w+)([^`]*?)`/gm)];
for (const [, command, options] of commands) {
  const subcommand = options.match(/^ ([a-z]+)(?: |$)/)?.[1];
  const help = run([command, ...(subcommand ? [subcommand] : []), "--help"]);
  assert.match(help, new RegExp(`Usage: handoff ${command}\\b`));
  for (const option of options.match(/--[a-z-]+/g) ?? []) {
    assert.ok(help.includes(option), `${command} is missing documented ${option}`);
  }
}
for (const command of ["decide", "correct"]) {
  const help = run([command, "--help"]);
  for (const option of ["--key", "--evidence"]) assert.ok(help.includes(option));
}
const hint = run(["init"]).match(/handoff prime[^\n]*/)?.[0];
assert.ok(hint, "init should print a primer command");
run(["prime", "--tool", "generic"]);
writeFileSync(join(cwd, "evidence.txt"), "release smoke evidence\n");
run(["decide", "release smoke choice", "--key", "release.choice", "--evidence", "evidence.txt"]);
run(["correct", "release smoke action", "--user-said", "retain release evidence", "--key", "release.rule", "--evidence", "evidence.txt"]);
run(["stale", "--check"]);
run(["compact"]);
assert.ok(!/prime <target-tool>/.test(hint), "init must not suggest positional prime syntax");
console.log(`release check: ${pkg.version}, ${commands.length} documented commands and their options passed`);
