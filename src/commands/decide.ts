import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists, readOrEmpty, writeFileSafe } from "../util/fs.js";
import { withFileLock } from "../util/lock.js";
import { normalizeKey, revokeActiveByKey } from "./revocation.js";
import { captureEvidence } from "./evidence.js";

type DecideOpts = {
  choice: string;
  because?: string;
  alternatives?: string[];
  cwd?: string;
  /** Fact key: a newer entry under the same key revokes older active ones. */
  key?: string;
  evidence?: string[];
};

export async function decide(opts: DecideOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  const evidence = await captureEvidence(paths.root, opts.evidence);
  const key = opts.key?.trim() ? normalizeKey(opts.key) : undefined;
  const ts = new Date().toISOString();
  const entry = [
    `## ${ts}`,
    ``,
    key ? `**key:** ${key}\n` : null,
    `**chose:** ${opts.choice}`,
    opts.because ? `\n**because:** ${opts.because}` : null,
    opts.alternatives && opts.alternatives.length > 0
      ? `\n**considered:** ${opts.alternatives.join(", ")}`
      : null,
    ...evidence,
    ``,
    `---`,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  let revokedIds: string[] = [];
  await withFileLock(paths.decisions, async () => {
    // Revoke-then-append under one lock: a keyed entry supersedes older active
    // entries asserting the same key (marked in place, kept for audit).
    if (key) {
      const raw = await readOrEmpty(paths.decisions);
      const res = revokeActiveByKey(raw, key, ts, ts);
      if (res.revokedIds.length > 0) await writeFileSafe(paths.decisions, res.updated);
      revokedIds = res.revokedIds;
    }
    await appendLine(paths.decisions, "\n" + entry);
  });

  const revoked =
    revokedIds.length > 0
      ? ` (revoked ${revokedIds.length} stale entr${revokedIds.length === 1 ? "y" : "ies"} for key "${key}")`
      : "";
  console.log(`logged decision at ${ts}${revoked}`);
}
