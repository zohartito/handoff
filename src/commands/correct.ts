import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists } from "../util/fs.js";

type CorrectOpts = {
  action: string;
  userSaid: string;
  lesson?: string;
  cwd?: string;
};

export async function correct(opts: CorrectOpts): Promise<void> {
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
    `**agent did:** ${opts.action}`,
    `\n**user said:** ${opts.userSaid}`,
    opts.lesson ? `\n**lesson:** ${opts.lesson}` : null,
    ``,
    `---`,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  await appendLine(paths.corrections, "\n" + entry);
  console.log(`logged correction at ${ts}`);
}
