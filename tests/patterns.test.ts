import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patterns } from "../src/commands/patterns.js";

/**
 * Set up a root tmpdir containing N fake projects. Each project gets a
 * language marker file, a .handoff/meta.json with the requested sourceTool,
 * and a .handoff/corrections.md / attempts.md with the given bodies.
 */
function scaffoldProjects(
  specs: Array<{
    name: string;
    language: "python" | "node" | "rust" | "unknown";
    sourceTool: string;
    corrections?: string;
    attempts?: string;
  }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "handoff-patterns-"));
  for (const s of specs) {
    const projDir = join(root, s.name);
    mkdirSync(join(projDir, ".handoff"), { recursive: true });
    // Language marker
    if (s.language === "python") {
      writeFileSync(join(projDir, "pyproject.toml"), "[project]\nname='x'\n");
    } else if (s.language === "node") {
      writeFileSync(join(projDir, "package.json"), '{"name":"x"}');
    } else if (s.language === "rust") {
      writeFileSync(join(projDir, "Cargo.toml"), "[package]\nname='x'\n");
    }
    writeFileSync(
      join(projDir, ".handoff", "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        sourceTool: s.sourceTool,
        sourceVersion: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        projectRoot: projDir,
      }),
    );
    writeFileSync(join(projDir, ".handoff", "corrections.md"), s.corrections ?? "");
    writeFileSync(join(projDir, ".handoff", "attempts.md"), s.attempts ?? "");
  }
  return root;
}

function withSilencedStdout<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = origLog;
  });
}

// --- 1: result shape + cross-project signal -------------------------------

test("patterns: returns shape with correctionThemes, failureModes, toolUsage", async () => {
  const root = scaffoldProjects([
    {
      name: "py-a",
      language: "python",
      sourceTool: "claude-code",
      corrections:
        "Agent used os.path instead of pathlib again.\n" +
        "Remember to prefer pathlib over os.path for new code.\n",
      attempts:
        "Tried importing os.path first. That approach failed.\n" +
        "The failed approach was to use os module directly.\n",
    },
    {
      name: "py-b",
      language: "python",
      sourceTool: "claude-code",
      corrections:
        "Keep preferring pathlib. The agent suggested os.path once more.\n" +
        "Pathlib path objects are idiomatic.\n",
      attempts:
        "Attempted os.path approach and it failed.\n" +
        "That approach was rejected because pathlib is cleaner.\n",
    },
    {
      name: "node-c",
      language: "node",
      sourceTool: "cursor",
      corrections:
        "Agent kept using var instead of const. Prefer const always.\n",
      attempts:
        "Tried using var declarations. That failed review.\n",
    },
  ]);
  try {
    const result = await withSilencedStdout(() =>
      patterns({ roots: [root] }),
    );
    assert.equal(result.projectCount, 3);
    assert.ok(Array.isArray(result.correctionThemes));
    assert.ok(Array.isArray(result.failureModes));
    assert.ok(result.correctionThemes.length > 0, "expected non-empty correctionThemes");
    assert.ok(result.failureModes.length > 0, "expected non-empty failureModes");
    assert.equal(typeof result.toolUsage, "object");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 2: top correction theme is cross-project ------------------------------

test("patterns: top correction theme appears in >=2 projects", async () => {
  const root = scaffoldProjects([
    {
      name: "py-a",
      language: "python",
      sourceTool: "claude-code",
      corrections:
        "Prefer pathlib over os.path. The pathlib module is cleaner.\n" +
        "Pathlib avoids string concatenation bugs.\n",
    },
    {
      name: "py-b",
      language: "python",
      sourceTool: "claude-code",
      corrections:
        "Again pathlib is preferred. Pathlib handles cross-platform paths.\n",
    },
    {
      name: "node-c",
      language: "node",
      sourceTool: "cursor",
      corrections: "Prefer const over var.\n",
    },
  ]);
  try {
    const result = await withSilencedStdout(() =>
      patterns({ roots: [root] }),
    );
    assert.ok(result.correctionThemes.length > 0);
    const top = result.correctionThemes[0];
    assert.ok(
      top.projectCount >= 2,
      `top theme "${top.ngram}" should span >=2 projects, got ${top.projectCount}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 3: language tags correct -----------------------------------

test("patterns: language tags reflect where the ngram actually appeared", async () => {
  const root = scaffoldProjects([
    {
      name: "py-a",
      language: "python",
      sourceTool: "claude-code",
      corrections: "Prefer pathlib for paths. Pathlib is idiomatic python.\n",
    },
    {
      name: "node-b",
      language: "node",
      sourceTool: "claude-code",
      corrections: "Pathlib is not relevant but the word pathlib shows up in notes.\n",
    },
  ]);
  try {
    const result = await withSilencedStdout(() =>
      patterns({ roots: [root] }),
    );
    const pathlibTheme = result.correctionThemes.find((t) => t.ngram === "pathlib");
    assert.ok(pathlibTheme, "expected 'pathlib' ngram to be present");
    assert.deepEqual(pathlibTheme.languages.sort(), ["node", "python"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 4: empty fixture ----------------------------------

test("patterns: empty root yields empty result, no throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-patterns-empty-"));
  try {
    const result = await withSilencedStdout(() =>
      patterns({ roots: [root] }),
    );
    assert.equal(result.projectCount, 0);
    assert.deepEqual(result.correctionThemes, []);
    assert.deepEqual(result.failureModes, []);
    assert.deepEqual(result.toolUsage, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 5: top: N respected ---------------------------------

test("patterns: top:3 caps correctionThemes at 3 entries", async () => {
  // Build two projects with a wide vocabulary so plenty of ngrams exist.
  const vocab = [
    "pathlib", "typing", "asyncio", "dataclasses", "pytest", "mypy",
    "logging", "subprocess", "functools", "itertools",
  ];
  const body = vocab.map((w) => `Prefer ${w} for python. ${w} is idiomatic.\n`).join("");
  const root = scaffoldProjects([
    {
      name: "py-a",
      language: "python",
      sourceTool: "claude-code",
      corrections: body,
    },
    {
      name: "py-b",
      language: "python",
      sourceTool: "claude-code",
      corrections: body,
    },
  ]);
  try {
    const result = await withSilencedStdout(() =>
      patterns({ roots: [root], top: 3 }),
    );
    assert.equal(result.correctionThemes.length, 3, "top:3 should cap output at 3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 6: tool usage counts ---------------------------------

test("patterns: toolUsage tallies sourceTool across projects", async () => {
  const root = scaffoldProjects([
    { name: "a", language: "python", sourceTool: "claude-code" },
    { name: "b", language: "node", sourceTool: "claude-code" },
    { name: "c", language: "rust", sourceTool: "cursor" },
  ]);
  try {
    const result = await withSilencedStdout(() =>
      patterns({ roots: [root] }),
    );
    assert.deepEqual(result.toolUsage, { "claude-code": 2, cursor: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 7: HANDOFF_SEARCH_ROOTS env override ---------------------------------

test("patterns: HANDOFF_SEARCH_ROOTS env var overrides default search roots", async () => {
  const root = scaffoldProjects([
    {
      name: "env-only",
      language: "python",
      sourceTool: "codex",
      corrections: "Prefer pathlib over os.path.\n",
    },
  ]);
  const prev = process.env.HANDOFF_SEARCH_ROOTS;
  process.env.HANDOFF_SEARCH_ROOTS = root;
  try {
    // No `roots` passed — must pick up env var.
    const result = await withSilencedStdout(() => patterns({}));
    assert.equal(result.projectCount, 1, "env root should be honored");
    assert.deepEqual(result.toolUsage, { codex: 1 });
  } finally {
    if (prev === undefined) {
      delete process.env.HANDOFF_SEARCH_ROOTS;
    } else {
      process.env.HANDOFF_SEARCH_ROOTS = prev;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
