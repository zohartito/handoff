import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHandoffProjects } from "../src/util/discover.js";
import { searchProjects } from "../src/commands/search.js";

/**
 * Each test builds an isolated sandbox under the OS tmpdir so we never
 * touch the user's real project tree or the default discovery roots.
 * We drive discovery by passing an explicit `roots` argument (or
 * through HANDOFF_SEARCH_ROOTS) so the defaults stay out of scope.
 */

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "handoff-search-test-"));
}

function writeProject(
  root: string,
  relPath: string,
  opts: {
    withMeta?: boolean;
    updatedAt?: string;
    files?: Record<string, string>;
  } = {},
): string {
  const projectDir = join(root, relPath);
  mkdirSync(projectDir, { recursive: true });
  if (opts.withMeta !== false) {
    const handoff = join(projectDir, ".handoff");
    mkdirSync(handoff, { recursive: true });
    const meta = {
      schemaVersion: 1,
      sourceTool: "claude-code",
      sourceVersion: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: opts.updatedAt ?? "2026-04-01T00:00:00.000Z",
      projectRoot: projectDir,
    };
    writeFileSync(join(handoff, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    for (const [name, body] of Object.entries(opts.files ?? {})) {
      writeFileSync(join(handoff, name), body, "utf8");
    }
  }
  return projectDir;
}

// --- discover: finds projects with meta.json, skips ones without --------

test("discoverHandoffProjects: finds project with .handoff/meta.json, skips one without", async () => {
  const root = makeSandbox();
  try {
    const good = writeProject(root, "proj-a", { withMeta: true });
    // proj-b has a .handoff/ folder but NO meta.json — must be skipped
    const bDir = join(root, "proj-b", ".handoff");
    mkdirSync(bDir, { recursive: true });
    writeFileSync(join(bDir, "task.md"), "stub", "utf8");
    // proj-c is a plain directory with no .handoff/ at all
    mkdirSync(join(root, "proj-c"), { recursive: true });

    const projects = await discoverHandoffProjects({ roots: [root] });
    const paths = projects.map((p) => p.projectPath);
    assert.equal(projects.length, 1, `expected 1 project, got ${paths.join(",")}`);
    assert.equal(projects[0]!.projectPath, good);
    assert.equal(projects[0]!.handoffDir, join(good, ".handoff"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- discover: skips node_modules even if .handoff/ is nested inside ----

test("discoverHandoffProjects: skips node_modules/ even when a .handoff/ is nested inside", async () => {
  const root = makeSandbox();
  try {
    // legitimate project at the top
    const good = writeProject(root, "real", { withMeta: true });
    // a fake project inside node_modules — must NOT be picked up
    writeProject(root, "real/node_modules/some-pkg", { withMeta: true });
    // also try .git, dist, __pycache__
    writeProject(root, "real/.git/hooks", { withMeta: true });
    writeProject(root, "real/dist/x", { withMeta: true });
    writeProject(root, "real/__pycache__/y", { withMeta: true });

    const projects = await discoverHandoffProjects({ roots: [root] });
    assert.equal(projects.length, 1, `expected only the top-level project, got ${projects.map((p) => p.projectPath).join(", ")}`);
    assert.equal(projects[0]!.projectPath, good);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- discover: ordering by updatedAt desc, null last --------------------

test("discoverHandoffProjects: results are sorted by updatedAt desc, null last", async () => {
  const root = makeSandbox();
  try {
    const older = writeProject(root, "older", {
      updatedAt: "2026-01-15T12:00:00.000Z",
    });
    const newer = writeProject(root, "newer", {
      updatedAt: "2026-04-10T09:30:00.000Z",
    });
    // Project with a meta.json that has no `updatedAt` field — should
    // land LAST in the sorted output.
    const noneDir = join(root, "none", ".handoff");
    mkdirSync(noneDir, { recursive: true });
    writeFileSync(
      join(noneDir, "meta.json"),
      JSON.stringify({ schemaVersion: 1, sourceTool: "codex" }),
      "utf8",
    );
    const none = join(root, "none");

    const projects = await discoverHandoffProjects({ roots: [root] });
    assert.equal(projects.length, 3);
    assert.equal(projects[0]!.projectPath, newer, "newest first");
    assert.equal(projects[1]!.projectPath, older, "older second");
    assert.equal(projects[2]!.projectPath, none, "null updatedAt last");
    assert.equal(projects[2]!.updatedAt, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- discover: HANDOFF_SEARCH_ROOTS override works ----------------------

test("discoverHandoffProjects: HANDOFF_SEARCH_ROOTS env var overrides defaults", async () => {
  const root = makeSandbox();
  const prev = process.env.HANDOFF_SEARCH_ROOTS;
  try {
    const a = writeProject(root, "env-a", { updatedAt: "2026-02-01T00:00:00.000Z" });
    const b = writeProject(root, "env-b", { updatedAt: "2026-03-01T00:00:00.000Z" });
    // Use both separators; platform-independent separator support.
    const sep = process.platform === "win32" ? ";" : ":";
    process.env.HANDOFF_SEARCH_ROOTS = `${join(root, "env-a")}${sep}${join(root, "env-b")}`;

    const projects = await discoverHandoffProjects();
    const paths = projects.map((p) => p.projectPath).sort();
    assert.deepEqual(paths, [a, b].sort(), `unexpected env-root result: ${paths.join(", ")}`);
    // Newer first
    assert.equal(projects[0]!.projectPath, b);
  } finally {
    if (prev === undefined) delete process.env.HANDOFF_SEARCH_ROOTS;
    else process.env.HANDOFF_SEARCH_ROOTS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

// --- search: finds matches across multiple projects ---------------------

test("searchProjects: returns expected matches across a two-project fixture", async () => {
  const root = makeSandbox();
  try {
    writeProject(root, "alpha", {
      updatedAt: "2026-04-10T00:00:00.000Z",
      files: {
        "corrections.md":
          "# Corrections\n\nDo not use os.path; use pathlib.Path instead.\nanother line\n",
        "attempts.md": "# Attempts\n\nTried pathlib but hit a bug.\n",
      },
    });
    writeProject(root, "beta", {
      updatedAt: "2026-02-01T00:00:00.000Z",
      files: {
        "decisions.md":
          "# Decisions\n\nChose pathlib over os.path for portability.\n",
        "progress.md": "# Progress\n\nNo matches here.\n",
      },
    });

    const { matches, projectsScanned } = await searchProjects("pathlib", {
      roots: [root],
    });
    assert.equal(projectsScanned, 2);
    assert.equal(matches.length, 3, `expected 3 matches, got ${matches.length}`);
    // alpha is newer, so its matches come first within the same exactWord tier.
    const alphaMatches = matches.filter((m) => m.projectPath.endsWith("alpha"));
    const betaMatches = matches.filter((m) => m.projectPath.endsWith("beta"));
    assert.equal(alphaMatches.length, 2);
    assert.equal(betaMatches.length, 1);
    // First-ranked alpha match should precede first beta match
    const firstAlphaIdx = matches.findIndex((m) => m.projectPath.endsWith("alpha"));
    const firstBetaIdx = matches.findIndex((m) => m.projectPath.endsWith("beta"));
    assert.ok(firstAlphaIdx < firstBetaIdx, "newer project ranks above older");
    // Every match carries relativeFile, lineNumber, and a trimmed line
    for (const m of matches) {
      assert.match(m.relativeFile, /^\.handoff\//);
      assert.ok(m.lineNumber > 0);
      assert.ok(m.line.length > 0);
      assert.ok(m.line.length <= 140);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- search: respects limit ---------------------------------------------

test("searchProjects: respects the `limit` option", async () => {
  const root = makeSandbox();
  try {
    const manyLines = Array.from({ length: 50 }, (_, i) => `line-${i} pathlib here`).join("\n");
    writeProject(root, "big", {
      updatedAt: "2026-04-01T00:00:00.000Z",
      files: { "progress.md": `# Progress\n\n${manyLines}\n` },
    });

    const { matches } = await searchProjects("pathlib", {
      roots: [root],
      limit: 5,
    });
    assert.equal(matches.length, 5, `expected 5 after limit, got ${matches.length}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- search: case-insensitive by default; caseSensitive respected -------

test("searchProjects: case-insensitive by default, caseSensitive=true respected", async () => {
  const root = makeSandbox();
  try {
    writeProject(root, "casey", {
      updatedAt: "2026-04-01T00:00:00.000Z",
      files: {
        "corrections.md": "# Corrections\n\nFooBar went here.\nfoobar lowercase.\nFOOBAR shouting.\n",
      },
    });

    // Default: case-insensitive — all three lines match
    const insensitive = await searchProjects("foobar", { roots: [root] });
    assert.equal(insensitive.matches.length, 3);

    // caseSensitive=true — only the exact-case match
    const sensitive = await searchProjects("foobar", {
      roots: [root],
      caseSensitive: true,
    });
    assert.equal(sensitive.matches.length, 1);
    assert.match(sensitive.matches[0]!.line, /^foobar lowercase/);

    // Also exact-case match of "FOOBAR" picks only the SHOUTING line
    const shouty = await searchProjects("FOOBAR", {
      roots: [root],
      caseSensitive: true,
    });
    assert.equal(shouty.matches.length, 1);
    assert.match(shouty.matches[0]!.line, /FOOBAR shouting/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- search: no matches returns empty array, no error -------------------

test("searchProjects: no matches returns an empty matches array", async () => {
  const root = makeSandbox();
  try {
    writeProject(root, "nope", {
      files: { "task.md": "# Task\n\njust some other content\n" },
    });

    const { matches, projectsScanned } = await searchProjects("nonexistent-token", {
      roots: [root],
    });
    assert.equal(projectsScanned, 1);
    assert.equal(matches.length, 0);
    assert.ok(Array.isArray(matches));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- search: exact-word matches rank above substring matches ------------

test("searchProjects: exact-word matches rank above substring matches", async () => {
  const root = makeSandbox();
  try {
    // The more recently updated project only has substring matches;
    // the older project has an exact-word match. The exact-word match
    // must still come first because rule (1) beats rule (2).
    writeProject(root, "newer-substr", {
      updatedAt: "2026-04-15T00:00:00.000Z",
      files: { "progress.md": "# Progress\n\nthe cat-astrophy approaches\n" },
    });
    writeProject(root, "older-exact", {
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: { "progress.md": "# Progress\n\nthe cat sat on the mat\n" },
    });

    const { matches } = await searchProjects("cat", { roots: [root] });
    assert.equal(matches.length, 2);
    assert.ok(
      matches[0]!.projectPath.endsWith("older-exact"),
      `expected exact-word match first; got ${matches[0]!.projectPath}`,
    );
    assert.equal(matches[0]!.exactWord, true);
    assert.equal(matches[1]!.exactWord, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
