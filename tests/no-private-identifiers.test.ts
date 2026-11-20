// HOF-N6: tracked files must not name the author's workstation or Windows account.
// Only SHA-256 fingerprints are stored, so neither this test nor its failure output discloses the names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MACHINE_FP = "49e7bdf0d9a6603491bdffc40adcc8f94eea9630428db0981599fdb1b7a79ba1"; // two tokens joined by "-"
const ACCOUNT_FP = "930705203a1bb60e6de569401ceaa610830d5705fc96ed3c41e7ec5aef4bdd33"; // one token

const fingerprint = (token: string): string => createHash("sha256").update(token).digest("hex");

test("HOF-N6: tracked files hold no private workstation or account identifiers", () => {
  const root = process.cwd();
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
  const leaked = names.filter((name) => {
    const path = join(root, name);
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    const tokens = readFileSync(path).toString("latin1").toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return tokens.some((token, i) =>
      fingerprint(token) === ACCOUNT_FP || (i + 1 < tokens.length && fingerprint(`${token}-${tokens[i + 1]}`) === MACHINE_FP));
  });
  assert.deepEqual(leaked, [], "private workstation or account identifier in tracked files");
});
