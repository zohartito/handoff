import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MANUAL_UNINSTALL_GUIDES, manualUninstallGuide } from "../src/frozen.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

test("stateful CLI refusal occurs before creating or opening project state", () => {
  const project = mkdtempSync(join(tmpdir(), "handoff-disabled-"));
  try {
    const result = spawnSync(process.execPath, [CLI, "init"], {
      cwd: project,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /permanently disabled/);
    assert.equal(existsSync(join(project, ".handoff")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every historical stateful command is refused with hostile environment and state", () => {
  const project = mkdtempSync(join(tmpdir(), "handoff-disabled-all-"));
  const outside = join(project, "outside");
  const shimDir = join(project, "path-shim");
  mkdirSync(outside);
  mkdirSync(shimDir);
  writeFileSync(join(outside, "task.md"), "NEVER-READ-STATE");
  writeFileSync(join(shimDir, "git"), "#!/bin/sh\nprintf PATH-SHIM-RAN >&2\nexit 99\n");
  symlinkSync(outside, join(project, ".handoff"));
  const cases: ReadonlyArray<readonly string[]> = [
    ["init"], ["status"], ["save"], ["attempt", "x"], ["decide", "x"],
    ["correct", "x"], ["capture"], ["prime"], ["install", "--tool", "cursor"],
    ["doctor"], ["hook", "pre-compact"], ["switch", "cursor"], ["ingest"],
    ["obsidian"], ["search", "x"], ["patterns"], ["verify"], ["mcp"],
    ["evaluate"], ["sync"],
  ];
  try {
    for (const args of cases) {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: shimDir,
          HANDOFF_PROJECT_ROOT: outside,
          HANDOFF_OBSIDIAN_VAULT: outside,
          HANDOFF_CONFIG: join(outside, "config.json"),
        },
      });
      assert.notEqual(result.status, 0, args.join(" "));
      assert.match(result.stderr, /permanently disabled/, args.join(" "));
      assert.doesNotMatch(result.stdout + result.stderr, /NEVER-READ-STATE|PATH-SHIM-RAN/, args.join(" "));
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("stateless help and version remain available", () => {
  for (const arg of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, [CLI, arg], { encoding: "utf8" });
    assert.equal(result.status, 0, arg);
  }
});

test("a symlinked state root is refused before prime can materialize its target", () => {
  const project = mkdtempSync(join(tmpdir(), "handoff-disabled-link-"));
  const outside = join(project, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "task.md"), "SECRET-MUST-NOT-APPEAR");
  symlinkSync(outside, join(project, ".handoff"));
  try {
    const result = spawnSync(process.execPath, [CLI, "prime"], { cwd: project, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /permanently disabled/);
    assert.doesNotMatch(result.stdout, /SECRET-MUST-NOT-APPEAR/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("manual uninstall is the only operational command and never recommends doctor", () => {
  for (const [tool, guide] of Object.entries(MANUAL_UNINSTALL_GUIDES)) {
    const result = spawnSync(process.execPath, [CLI, "uninstall", "--tool", tool], { encoding: "utf8" });
    assert.equal(result.status, 0, tool);
    assert.equal(result.stdout, `${guide}\n`, tool);
    assert.match(result.stdout, /Do not run handoff doctor/, tool);
    assert.match(result.stdout, /Preserve any existing \.handoff data/, tool);
    assert.doesNotMatch(result.stdout, /rm\s+-rf|Remove-Item\s+-Recurse|del\s+\/s/i, tool);
  }
  const claude = manualUninstallGuide("claude-code")!;
  assert.match(claude, /SessionStart.*UserPromptSubmit.*Stop.*StopFailure.*PreCompact/s);
  assert.match(claude, /plugin.*marketplace/is);
  assert.match(claude, /backup.*atomic/is);
  assert.match(manualUninstallGuide("codex")!, /~\/\.codex\/config\.toml/);
  assert.equal(manualUninstallGuide("unknown"), null);
});

test("package exports deny every legacy direct-import path", () => {
  for (const path of [
    "@zohartito/handoff/dist/cli.js",
    "@zohartito/handoff/dist/mcp/server.js",
    "@zohartito/handoff/dist/adapters/codex.js",
    "@zohartito/handoff/dist/adapters/cursor.js",
    "@zohartito/handoff/dist/adapters/gemini.js",
    "@zohartito/handoff/dist/adapters/paste.js",
  ]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `import(${JSON.stringify(path)})`], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, path);
    assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/, path);
  }
});

test("the package root import is side-effect-free", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", 'await import("@zohartito/handoff")'], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
