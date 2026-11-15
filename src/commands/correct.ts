import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists, readOrEmpty, writeFileSafe } from "../util/fs.js";
import { withFileLock } from "../util/lock.js";
import { hashEntry, registerSeenHash } from "../util/capture-state.js";
import { normalizeKey, revokeActiveByKey } from "./revocation.js";
import { captureEvidence } from "./evidence.js";

type CorrectOpts = {
  action: string;
  userSaid: string;
  lesson?: string;
  cwd?: string;
  /** "auto" tags the entry as auto-captured; anything else is manual. */
  source?: "auto" | "manual";
  /** Suppress the success console.log (used by the Stop-hook auto path). */
  quiet?: boolean;
  /** Fact key: a newer entry under the same key revokes older active ones. */
  key?: string;
  evidence?: string[];
};

export async function correct(opts: CorrectOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  const evidence = await captureEvidence(paths.root, opts.evidence);
  const isAuto = opts.source === "auto";
  const key = opts.key?.trim() ? normalizeKey(opts.key) : undefined;
  const ts = new Date().toISOString();
  const entry = [
    `## ${ts}`,
    ``,
    isAuto ? `**source:** auto\n` : null,
    key ? `**key:** ${key}\n` : null,
    `**agent did:** ${opts.action}`,
    `\n**user said:** ${opts.userSaid}`,
    opts.lesson ? `\n**lesson:** ${opts.lesson}` : null,
    ...evidence,
    ``,
    `---`,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  let revokedIds: string[] = [];
  await withFileLock(paths.corrections, async () => {
    // Revoke-then-append under one lock: a keyed entry supersedes older active
    // entries asserting the same key (marked in place, kept for audit).
    if (key) {
      const raw = await readOrEmpty(paths.corrections);
      const res = revokeActiveByKey(raw, key, ts, ts);
      if (res.revokedIds.length > 0) await writeFileSafe(paths.corrections, res.updated);
      revokedIds = res.revokedIds;
    }
    await appendLine(paths.corrections, "\n" + entry);
  });

  // Manual entries register their hash so a later auto Stop won't re-log them.
  // Best-effort: dedup state must never break the logging command.
  if (!isAuto) {
    try {
      await registerSeenHash(paths.captureState, hashEntry("correct", [opts.userSaid]));
    } catch {
      /* dedup is advisory only */
    }
  }

  if (!opts.quiet) {
    const revoked =
      revokedIds.length > 0
        ? ` (revoked ${revokedIds.length} stale entr${revokedIds.length === 1 ? "y" : "ies"} for key "${key}")`
        : "";
    console.log(`logged correction at ${ts}${revoked}`);
  }
}
