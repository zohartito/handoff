import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists } from "../util/fs.js";
import { withFileLock } from "../util/lock.js";
import { hashEntry, registerSeenHash } from "../util/capture-state.js";

type AttemptOpts = {
  what: string;
  error?: string;
  fix?: string;
  summary?: string;
  cwd?: string;
  /** "auto" tags the entry as auto-captured; anything else is manual. */
  source?: "auto" | "manual";
  /** Suppress the success console.log (used by the Stop-hook auto path). */
  quiet?: boolean;
};

export async function attempt(opts: AttemptOpts): Promise<void> {
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
    `**tried:** ${opts.what}`,
    opts.error ? `\n**error:**\n\n\`\`\`\n${opts.error.trim()}\n\`\`\`` : null,
    opts.fix ? `\n**fix:** ${opts.fix}` : null,
    opts.summary ? `\n**summary:** ${opts.summary}` : null,
    ``,
    `---`,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  await withFileLock(paths.attempts, () => appendLine(paths.attempts, "\n" + entry));

  // Manual entries register their hash so a later auto Stop won't re-log them.
  // Best-effort: dedup state must never break the logging command.
  if (!isAuto) {
    try {
      await registerSeenHash(paths.captureState, hashEntry("attempt", [opts.what]));
    } catch {
      /* dedup is advisory only */
    }
  }

  if (!opts.quiet) console.log(`logged attempt at ${ts}`);
}
