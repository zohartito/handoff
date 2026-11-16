// HOF-51: every GitHub Action is pinned to a full commit id, not a movable tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflows = join(process.cwd(), ".github", "workflows");

test("HOF-51: workflow actions are pinned to full commit ids", () => {
  const refs = readdirSync(workflows)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) =>
      [...readFileSync(join(workflows, name), "utf8").matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((m) => m[1]),
    );
  assert.ok(refs.length > 0, "expected workflow actions");
  const mutable = refs.filter((ref) => !ref.startsWith("./") && !/^[^@]+@[0-9a-f]{40}$/.test(ref));
  assert.deepEqual(mutable, []);
});
