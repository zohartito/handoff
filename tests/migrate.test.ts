import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateMeta,
  loadMeta,
  CURRENT_SCHEMA_VERSION,
  migrators as defaultMigrators,
  type Migrator,
} from "../src/format/migrate.js";
import type { Meta } from "../src/format/types.js";

// --- migrateMeta: pure function -------------------------------------------

test("migrateMeta: current-version meta passes through unchanged, no warnings", async () => {
  const input: Meta = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sourceTool: "claude-code",
    sourceVersion: "0.1.1",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    projectRoot: "/project",
  };
  const result = await migrateMeta(input);
  assert.equal(result.didMigrate, false);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.meta, input);
});

test("migrateMeta: missing schemaVersion is treated as v1 and emits a warning", async () => {
  const input = {
    sourceTool: "claude-code",
    sourceVersion: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    projectRoot: "/project",
  };
  const result = await migrateMeta(input);
  assert.equal(result.didMigrate, false, "no migrators exist today, so no migration runs");
  assert.ok(
    result.warnings.some((w) => /missing `schemaVersion`/.test(w)),
    `expected missing-schemaVersion warning, got: ${JSON.stringify(result.warnings)}`,
  );
  // Meta is returned with schemaVersion: 1 filled in.
  assert.equal(result.meta?.schemaVersion, 1);
  assert.equal(result.meta?.sourceTool, "claude-code");
});

test("migrateMeta: schemaVersion from the future warns and returns meta as-is", async () => {
  const input = {
    schemaVersion: 999,
    sourceTool: "claude-code",
    sourceVersion: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    projectRoot: "/project",
    someFutureField: true,
  };
  const result = await migrateMeta(input);
  assert.equal(result.didMigrate, false);
  assert.ok(
    result.warnings.some((w) => /schemaVersion is 999/.test(w) && /only understands/.test(w)),
    `expected forward-compat warning, got: ${JSON.stringify(result.warnings)}`,
  );
  // Forward-compat: the unknown future field survives.
  assert.equal(result.meta?.schemaVersion, 999);
  assert.equal((result.meta as unknown as { someFutureField: boolean }).someFutureField, true);
});

test("migrateMeta: injected v1→v2 migrator runs when target is v2 (demo framework test)", async () => {
  // Fake migrator: v1 adds a new `tags` field and bumps version to 2.
  const fakeMigrator: Migrator = (old) => ({
    ...old,
    schemaVersion: 2,
    tags: [], // new field introduced in v2
  });

  const v1Meta = {
    schemaVersion: 1,
    sourceTool: "cursor",
    sourceVersion: "1.0.0",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    projectRoot: "/project",
  };

  const result = await migrateMeta(v1Meta, {
    migrators: { 1: fakeMigrator },
    currentVersion: 2,
  });

  assert.equal(result.didMigrate, true, "should have run the migrator");
  assert.deepEqual(result.warnings, [], "no warnings on a clean migration");
  assert.equal(result.meta?.schemaVersion, 2);
  assert.deepEqual(
    (result.meta as unknown as { tags: string[] }).tags,
    [],
    "v1→v2 migrator should have added `tags`",
  );
  // Original fields are preserved.
  assert.equal(result.meta?.sourceTool, "cursor");
});

test("migrateMeta: chained v1→v2→v3 migrators run in sequence", async () => {
  const v1to2: Migrator = (old) => ({ ...old, schemaVersion: 2, v2Field: "added" });
  const v2to3: Migrator = (old) => ({ ...old, schemaVersion: 3, v3Field: "added" });

  const result = await migrateMeta(
    { schemaVersion: 1, sourceTool: "cursor", projectRoot: "/p" },
    { migrators: { 1: v1to2, 2: v2to3 }, currentVersion: 3 },
  );
  assert.equal(result.didMigrate, true);
  assert.equal(result.meta?.schemaVersion, 3);
  assert.equal((result.meta as unknown as { v2Field: string }).v2Field, "added");
  assert.equal((result.meta as unknown as { v3Field: string }).v3Field, "added");
});

test("migrateMeta: missing migrator for intermediate version warns and stops", async () => {
  // currentVersion=3 but only 1→2 migrator registered. We expect migration to
  // advance to v2 and then bail with a warning (not infinite-loop, not crash).
  const v1to2: Migrator = (old) => ({ ...old, schemaVersion: 2 });
  const result = await migrateMeta(
    { schemaVersion: 1, sourceTool: "cursor", projectRoot: "/p" },
    { migrators: { 1: v1to2 }, currentVersion: 3 },
  );
  assert.equal(result.didMigrate, true, "at least one migrator ran");
  assert.equal(result.meta?.schemaVersion, 2, "stopped at v2 (no v2→v3 migrator)");
  assert.ok(
    result.warnings.some((w) => /no migrator registered for schemaVersion 2/.test(w)),
    `expected stall warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test("migrateMeta: non-advancing migrator is guarded (no infinite loop)", async () => {
  // A buggy migrator that returns the same version. Must not loop.
  const buggy: Migrator = (old) => ({ ...old, schemaVersion: 1 });
  const result = await migrateMeta(
    { schemaVersion: 1, sourceTool: "cursor", projectRoot: "/p" },
    { migrators: { 1: buggy }, currentVersion: 2 },
  );
  assert.ok(
    result.warnings.some((w) => /did not advance schemaVersion/.test(w)),
    `expected non-advancing guard warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test("migrateMeta: null input returns null meta, no warnings", async () => {
  const result = await migrateMeta(null);
  assert.equal(result.meta, null);
  assert.equal(result.didMigrate, false);
  assert.deepEqual(result.warnings, []);
});

test("migrateMeta: non-object input (string) is treated as corrupt and ignored", async () => {
  const result = await migrateMeta("not an object");
  assert.equal(result.meta, null);
  assert.equal(result.didMigrate, false);
  assert.ok(
    result.warnings.some((w) => /not an object/.test(w)),
    `expected corrupt-json warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test("migrateMeta: array input is treated as corrupt", async () => {
  const result = await migrateMeta([1, 2, 3]);
  assert.equal(result.meta, null);
  assert.ok(result.warnings.some((w) => /not an object/.test(w)));
});

test("migrateMeta: production `migrators` map is empty today (v1 is current)", () => {
  // This guards against accidentally bumping CURRENT_SCHEMA_VERSION without
  // also registering the relevant migrator.
  assert.equal(
    Object.keys(defaultMigrators).length,
    CURRENT_SCHEMA_VERSION - 1,
    "every version below current should have a migrator registered",
  );
});

// --- loadMeta: disk integration --------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "handoff-migrate-test-"));
}

test("loadMeta: missing file returns null and no rewrite happens", async () => {
  const dir = makeTmpDir();
  try {
    const result = await loadMeta(join(dir, "meta.json"));
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadMeta: current-version meta is returned verbatim with no rewrite", async () => {
  const dir = makeTmpDir();
  const metaPath = join(dir, "meta.json");
  try {
    const original: Meta = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sourceTool: "claude-code",
      sourceVersion: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      projectRoot: "/project",
    };
    // Hand-written byte layout so we can detect a rewrite by checksum.
    const onDiskText = "{\n" +
      '  "schemaVersion": ' + CURRENT_SCHEMA_VERSION + ",\n" +
      '  "sourceTool": "claude-code",\n' +
      '  "sourceVersion": null,\n' +
      '  "createdAt": "2025-01-01T00:00:00.000Z",\n' +
      '  "updatedAt": "2025-01-02T00:00:00.000Z",\n' +
      '  "projectRoot": "/project"\n' +
      "}";
    writeFileSync(metaPath, onDiskText, "utf8");
    const before = readFileSync(metaPath, "utf8");
    const result = await loadMeta(metaPath);
    const after = readFileSync(metaPath, "utf8");
    assert.deepEqual(result, original);
    assert.equal(
      after,
      before,
      "loadMeta must not rewrite the file when no migration is needed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadMeta: corrupt JSON file is treated as missing (returns null, no crash)", async () => {
  // Note: the underlying readJson<unknown>() catches parse errors and returns
  // null, so this code path is the same as "missing file". Documented here
  // to make the "decide; document" choice from the task spec explicit:
  //   corrupt JSON → null meta, no crash.
  const dir = makeTmpDir();
  const metaPath = join(dir, "meta.json");
  try {
    writeFileSync(metaPath, "{{{ not valid json", "utf8");
    const result = await loadMeta(metaPath);
    assert.equal(result, null, "corrupt JSON falls through readJson and returns null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
