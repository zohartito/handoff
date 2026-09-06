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

// --- handoff-tax primer selection + departing-tool tracking -----------------
//
// These exercise the integration the owner flagged: `switch` must never
// silently hand off a lossy primer, and direction must key off the tool
// actually handing off (not the immutable init-time source).

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectPrimer } from "../src/commands/switch.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

function scaffold(sourceTool: string, lastActiveTool?: string): {
  root: string;
  paths: ReturnType<typeof resolveHandoffPaths>;
} {
  const root = mkdtempSync(join(tmpdir(), "handoff-switch-"));
  mkdirSync(join(root, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(root);
  const meta: Record<string, unknown> = {
    schemaVersion: 1,
    sourceTool,
    sourceVersion: null,
    createdAt: "2026-04-16T10:00:00Z",
    updatedAt: "2026-04-16T12:00:00Z",
    projectRoot: root,
  };
  if (lastActiveTool !== undefined) meta.lastActiveTool = lastActiveTool;
  writeFileSync(paths.meta, JSON.stringify(meta, null, 2));
  // A task long enough that the compact primer truncates it — the exact
  // continuity the owner showed getting silently dropped.
  writeFileSync(
    paths.task,
    "# Task\n\n## Goal\n\n" + "Ship the portable-state CLI. ".repeat(60) + "\n",
  );
  writeFileSync(
    paths.corrections,
    "# Corrections\n" +
      "\n## 2026-04-12T14:15:00Z\n\n**agent did:** used os.path\n\n**user said:** always prefer pathlib\n\n---\n",
  );
  return { root, paths };
}

function captureStderr(): { restore: () => string } {
  const orig = console.error;
  let buf = "";
  console.error = (...a: unknown[]) => {
    buf += a.join(" ") + "\n";
  };
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buf += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      console.error = orig;
      process.stderr.write = origWrite;
      return buf;
    },
  };
}

test("selectPrimer defaults to the FULL primer — no silent downgrade", async () => {
  const { paths } = scaffold("claude-code");
  const res = await selectPrimer(paths, "codex", false);
  assert.equal(res.mode, "full");
  assert.equal(res.constraintFallback, false);
  // Full primer carries the whole task, not the compact pointer.
  assert.doesNotMatch(res.primer, /see \.handoff\/task\.md for full/);
});

test("selectPrimer returns compact ONLY when opted in, and it preserves constraints", async () => {
  const { paths } = scaffold("codex");
  const res = await selectPrimer(paths, "claude-code", true);
  assert.equal(res.mode, "compact");
  assert.equal(res.constraintFallback, false);
  // Compact is lossy (task truncated) but the user guardrail survives verbatim.
  assert.match(res.primer, /see \.handoff\/task\.md for full/);
  assert.match(res.primer, /always prefer pathlib/);
});

test("selectPrimer falls back to full when compaction would drop a constraint", async () => {
  const { paths } = scaffold("codex");
  // Many long, distinct constraints so the verbatim block overflows the compact
  // budget and the final hard-truncate would shed one.
  let corrections = "# Corrections\n";
  for (let i = 0; i < 40; i++) {
    corrections +=
      `\n## 2026-04-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z\n\n` +
      `**agent did:** thing ${i}\n\n` +
      `**user said:** rule number ${i} is ${"x".repeat(120)}\n\n---\n`;
  }
  writeFileSync(paths.corrections, corrections);
  const res = await selectPrimer(paths, "claude-code", true);
  assert.equal(res.mode, "full", "must not hand off a primer missing a guardrail");
  assert.equal(res.constraintFallback, true);
});

test("switch stamps lastActiveTool so the next switch keys direction off the departing tool", async () => {
  // Owner's reproduction: init claude-code → switch codex → switch claude-code
  // must classify the second switch as escalate, not lateral.
  const { root, paths } = scaffold("claude-code");
  const cap = captureStderr();
  try {
    await switchTool({ tool: "codex", cwd: root, noSave: true, noLaunch: true });
    const afterFirst = JSON.parse(readFileSync(paths.meta, "utf8"));
    assert.equal(afterFirst.lastActiveTool, "codex", "arriving tool recorded");

    await switchTool({ tool: "claude-code", cwd: root, noSave: true, noLaunch: true });
    const afterSecond = JSON.parse(readFileSync(paths.meta, "utf8"));
    assert.equal(afterSecond.lastActiveTool, "claude-code");
  } finally {
    const out = cap.restore();
    // Second switch (codex → claude-code) is an escalation: advisory shown,
    // full primer auto-injected via the hook — nothing silently stripped.
    assert.match(out, /Handoff tax: escalating/);
    assert.doesNotMatch(out, /compact primer copied/);
  }
});

test("switch never says 'stripped' on an escalation unless --compact is passed", async () => {
  // Departing tool is codex (tier 3) → claude-code (tier 1) = escalate.
  const { root } = scaffold("claude-code", "codex");
  const cap = captureStderr();
  try {
    await switchTool({ tool: "cursor", cwd: root, noSave: true, noLaunch: true });
  } finally {
    const out = cap.restore();
    assert.match(out, /full primer copied to clipboard/);
    assert.doesNotMatch(out, /trajectory stripped/);
  }
});

test("switch --compact to claude-code is a surfaced no-op (hook injects full)", async () => {
  const { root } = scaffold("codex");
  const cap = captureStderr();
  try {
    await switchTool({ tool: "claude-code", cwd: root, noSave: true, noLaunch: true, compact: true });
  } finally {
    const out = cap.restore();
    assert.match(out, /full primer will auto-inject via Claude Code/);
    assert.match(out, /--compact does not apply to Claude Code/);
  }
});
