import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists } from "../util/fs.js";

type AttemptOpts = {
  what: string;
  error?: string;
  fix?: string;
  summary?: string;
  cwd?: string;
};

export async function attempt(opts: AttemptOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  const ts = new Date().toISOString();
  const entry = [
    `## ${ts}`,
    ``,
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

  await appendLine(paths.attempts, "\n" + entry);
  console.log(`logged attempt at ${ts}`);
}
