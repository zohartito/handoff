import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists } from "../util/fs.js";
import { withFileLock } from "../util/lock.js";
import { hashEntry, registerSeenHash } from "../util/capture-state.js";

type CorrectOpts = {
  action: string;
  userSaid: string;
  lesson?: string;
  cwd?: string;
  /** "auto" tags the entry as auto-captured; anything else is manual. */
  source?: "auto" | "manual";
  /** Suppress the success console.log (used by the Stop-hook auto path). */
  quiet?: boolean;
};

export async function correct(opts: CorrectOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  const isAuto = opts.source === "auto";
  const ts = new Date().toISOString();
  const entry = [
    `## ${ts}`,
    ``,
    isAuto ? `**source:** auto\n` : null,
    `**agent did:** ${opts.action}`,
    `\n**user said:** ${opts.userSaid}`,
    opts.lesson ? `\n**lesson:** ${opts.lesson}` : null,
    ``,
    `---`,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  await withFileLock(paths.corrections, () => appendLine(paths.corrections, "\n" + entry));

  // Manual entries register their hash so a later auto Stop won't re-log them.
  // Best-effort: dedup state must never break the logging command.
  if (!isAuto) {
    try {
      await registerSeenHash(paths.captureState, hashEntry("correct", [opts.userSaid]));
    } catch {
      /* dedup is advisory only */
    }
  }

  if (!opts.quiet) console.log(`logged correction at ${ts}`);
}
