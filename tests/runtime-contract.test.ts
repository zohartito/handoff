import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("HOF-10: declared Node minimum satisfies the locked runtime dependency", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const version = (range: string) => {
    const [major = 0, minor = 0, patch = 0] = range.replace(/^>=/, "").split(".").map(Number);
    return major * 1e6 + minor * 1e3 + patch;
  };
  assert.ok(version(pkg.engines.node) >= version(lock.packages["node_modules/commander"].engines.node));
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
});
