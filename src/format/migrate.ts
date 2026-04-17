import { writeJson, readJson } from "../util/fs.js";
import type { Meta } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

/**
 * The schemaVersion value written into newly-initialized meta.json files.
 * When a future breaking change to the Meta shape lands, bump this AND add
 * a migrator below for the previous version.
 */
export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * A migrator takes an old meta object (shape is whatever that version had)
 * and returns the next-version shape. The migrator is responsible for
 * setting the new `schemaVersion` on its output. Migrators run in sequence
 * from `raw.schemaVersion` up to `CURRENT_SCHEMA_VERSION`.
 *
 * The map is keyed by the "from" version — `migrators[1]` upgrades a v1
 * object to v2, `migrators[2]` upgrades v2 to v3, and so on.
 *
 * Today there are no migrators because v1 is still current. When v2 lands,
 * add an entry `1: (old) => ({ ...old, schemaVersion: 2, /* new field *\/ })`.
 */
export type Migrator = (old: any) => any;
export const migrators: Record<number, Migrator> = {};

export type MigrateResult = {
  meta: Meta | null;
  didMigrate: boolean;
  warnings: string[];
};

export type MigrateOptions = {
  /** Override the migrators map. Used by tests to register a fake migrator. */
  migrators?: Record<number, Migrator>;
  /** Override the target schema version. Used by tests. */
  currentVersion?: number;
};

/**
 * Inspect a raw parsed JSON value (as returned by `readJson`) and migrate
 * it to the current schema version.
 *
 * Behavior:
 * - `null` / `undefined` → treated as "no meta on disk". Returns meta=null
 *   with no warnings so callers can continue with the null case they
 *   already handle.
 * - Non-object (array / primitive) → treated as corrupt. Returns meta=null
 *   with a warning.
 * - Object without `schemaVersion` → treated as v1 (legacy meta), warning
 *   emitted, normal migration chain runs from v1.
 * - Object with `schemaVersion > CURRENT_SCHEMA_VERSION` → warning emitted
 *   ("from the future"), object returned as-is for forward-compat.
 * - Object with `schemaVersion < CURRENT_SCHEMA_VERSION` → migrators run
 *   in sequence until the object reaches the current version. `didMigrate`
 *   is true.
 * - Object at current version → passed through unchanged.
 */
export async function migrateMeta(
  raw: unknown,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const activeMigrators = options.migrators ?? migrators;
  const targetVersion = options.currentVersion ?? CURRENT_SCHEMA_VERSION;
  const warnings: string[] = [];

  if (raw === null || raw === undefined) {
    return { meta: null, didMigrate: false, warnings };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("meta.json is not an object — ignoring (treat as missing)");
    return { meta: null, didMigrate: false, warnings };
  }

  let obj = raw as Record<string, unknown>;
  let version: number;

  if (typeof obj.schemaVersion !== "number") {
    warnings.push(
      "meta.json missing `schemaVersion` — assuming v1 (legacy). re-run `handoff save` to rewrite it.",
    );
    version = 1;
    obj = { ...obj, schemaVersion: 1 };
  } else {
    version = obj.schemaVersion;
  }

  if (version > targetVersion) {
    warnings.push(
      `meta.json schemaVersion is ${version}, but this CLI only understands up to ${targetVersion}. ` +
        `upgrade the handoff CLI or the file was written by a newer version.`,
    );
    return { meta: obj as unknown as Meta, didMigrate: false, warnings };
  }

  let didMigrate = false;
  let current: any = obj;
  while (typeof current.schemaVersion === "number" && current.schemaVersion < targetVersion) {
    const from = current.schemaVersion as number;
    const migrator = activeMigrators[from];
    if (!migrator) {
      warnings.push(
        `no migrator registered for schemaVersion ${from} → ${from + 1}; leaving meta.json at v${from}.`,
      );
      break;
    }
    current = migrator(current);
    didMigrate = true;
    // Defensive: migrator must advance the version or we'd loop forever.
    if (
      typeof current.schemaVersion !== "number" ||
      current.schemaVersion <= from
    ) {
      warnings.push(
        `migrator for v${from} did not advance schemaVersion; aborting migration.`,
      );
      break;
    }
  }

  return {
    meta: current as Meta,
    didMigrate,
    warnings,
  };
}

/**
 * Read meta.json from `path`, run it through `migrateMeta`, and write any
 * migrated result back to disk so subsequent reads are fast. Warnings are
 * printed to stderr so they're visible to the user without polluting
 * stdout (which may be piped, e.g. by `handoff prime`).
 *
 * Returns the migrated (or as-is) meta object, or null if the file is
 * missing / unreadable — matching the legacy `readJson<Meta>` contract.
 */
export async function loadMeta(path: string): Promise<Meta | null> {
  const raw = await readJson<unknown>(path);
  const result = await migrateMeta(raw);
  for (const w of result.warnings) {
    process.stderr.write(`[handoff] ${w}\n`);
  }
  if (result.didMigrate && result.meta) {
    try {
      await writeJson(path, result.meta);
    } catch (err) {
      process.stderr.write(
        `[handoff] failed to persist migrated meta.json at ${path}: ${String(err)}\n`,
      );
    }
  }
  return result.meta;
}
