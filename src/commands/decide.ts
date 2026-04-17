import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists } from "../util/fs.js";

type DecideOpts = {
  choice: string;
  because?: string;
  alternatives?: string[];
  cwd?: string;
};

export async function decide(opts: DecideOpts): Promise<void> {
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
    `**chose:** ${opts.choice}`,
    opts.because ? `\n**because:** ${opts.because}` : null,
    opts.alternatives && opts.alternatives.length > 0
      ? `\n**considered:** ${opts.alternatives.join(", ")}`
      : null,
    ``,
    `---`,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  await appendLine(paths.decisions, "\n" + entry);
  console.log(`logged decision at ${ts}`);
}
