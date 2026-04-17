import { basename, resolve } from "node:path";
import { resolveHandoffPaths } from "../format/paths.js";
import { exists, readOrEmpty, writeFileSafe, ensureDir } from "../util/fs.js";
import { splitEntries } from "./prime.js";

export interface ObsidianOpts {
  /** Explicit vault path; falls back to env HANDOFF_OBSIDIAN_VAULT. */
  vault?: string;
  /** Project path; defaults to cwd. */
  project?: string;
}

export type ObsidianCounts = {
  daily: number;
  decisions: number;
  corrections: number;
  skipped: number;
};

/**
 * `handoff obsidian sync` — mirror the current project's `.handoff/` into an
 * Obsidian vault as per-day / per-decision / per-correction notes.
 *
 * Output layout inside the vault:
 *   Daily/YYYY-MM-DD.md                          (appended per run)
 *   Decisions/YYYY-MM-DD_<slug>_<decision>.md    (one per decision entry)
 *   Rules/<slug>__<correction>.md                (one per correction entry)
 *
 * Idempotent within a minute for the Daily note; decisions/corrections are
 * written only when content changes.
 */
export async function obsidian(opts: ObsidianOpts = {}): Promise<ObsidianCounts> {
  const vault = resolveVault(opts.vault);
  const projectPath = opts.project ? resolve(opts.project) : process.cwd();
  const slug = slugify(basename(projectPath));
  const paths = resolveHandoffPaths(projectPath);

  const now = new Date();
  const date = isoDate(now);
  const time = hhmm(now);

  // Read .handoff/ sources.
  const taskRaw = await readOrEmpty(paths.task);
  const attemptsRaw = await readOrEmpty(paths.attempts);
  const decisionsRaw = await readOrEmpty(paths.decisions);
  const correctionsRaw = await readOrEmpty(paths.corrections);

  const attempts = splitEntries(attemptsRaw);
  const decisions = splitEntries(decisionsRaw);
  const corrections = splitEntries(correctionsRaw);

  let skipped = 0;

  // Ensure vault subdirs exist.
  const dailyDir = resolve(vault, "Daily");
  const decisionsDir = resolve(vault, "Decisions");
  const rulesDir = resolve(vault, "Rules");
  await ensureDir(dailyDir);
  await ensureDir(decisionsDir);
  await ensureDir(rulesDir);

  // 1. Daily summary.
  const dailyPath = resolve(dailyDir, `${date}.md`);
  const block = renderDailyBlock({
    slug,
    time,
    task: taskRaw,
    attempts,
    decisions,
    corrections,
  });
  const blockHeader = `## handoff: ${slug} — ${time}`;
  let dailyWritten = 0;
  const existingDaily = await readOrEmpty(dailyPath);
  if (existingDaily.includes(blockHeader)) {
    skipped += 1;
  } else {
    const prefix = existingDaily
      ? existingDaily.endsWith("\n") ? existingDaily : existingDaily + "\n"
      : `# ${date}\n`;
    await writeFileSafe(dailyPath, prefix + "\n" + block);
    dailyWritten = 1;
  }

  // 2. Decisions → one file per entry.
  let decisionsWritten = 0;
  for (const entry of decisions) {
    const decSlug = slugifyEntry(entry);
    const file = resolve(decisionsDir, `${date}_${slug}_${decSlug}.md`);
    const body = renderDecisionNote({ projectPath, slug, date, entry });
    const wrote = await writeIfChanged(file, body);
    if (wrote) decisionsWritten += 1;
    else skipped += 1;
  }

  // 3. Corrections → Rules, one file per entry.
  let correctionsWritten = 0;
  for (const entry of corrections) {
    const corrSlug = slugifyEntry(entry);
    const file = resolve(rulesDir, `${slug}__${corrSlug}.md`);
    const body = renderRuleNote({ projectPath, slug, entry });
    const wrote = await writeIfChanged(file, body);
    if (wrote) correctionsWritten += 1;
    else skipped += 1;
  }

  const counts: ObsidianCounts = {
    daily: dailyWritten,
    decisions: decisionsWritten,
    corrections: correctionsWritten,
    skipped,
  };
  console.log(
    `obsidian sync: ${counts.daily} daily, ${counts.decisions} decisions, ${counts.corrections} rules, ${counts.skipped} skipped`,
  );
  return counts;
}

function resolveVault(explicit: string | undefined): string {
  const candidate = explicit ?? process.env.HANDOFF_OBSIDIAN_VAULT;
  if (!candidate) {
    throw new Error(
      "no vault configured; pass --vault or set HANDOFF_OBSIDIAN_VAULT",
    );
  }
  return resolve(candidate);
}

/**
 * Slug from an arbitrary string: lowercase, non-alphanumeric → `-`, collapse
 * runs, trim leading/trailing dashes.
 */
export function slugify(input: string): string {
  const lower = (input || "").toLowerCase();
  const replaced = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return replaced || "project";
}

/**
 * Slug from the first non-empty line of an entry, clipped to ~50 chars.
 * Strips leading `## <iso-ts>` lines and markdown bold markers so the slug
 * reflects the entry's *content*, not the timestamp header.
 */
export function slugifyEntry(entry: string): string {
  const lines = entry.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Skip the timestamp header (e.g. "## 2026-04-16T12:00:00Z").
    if (/^##\s+\d{4}-\d{2}-\d{2}T/.test(line)) continue;
    // Strip leading markdown emphasis like "**chose:**", "**agent did:**".
    const bare = line.replace(/\*\*[^*]+\*\*:?\s*/g, "").trim();
    const source = bare || line;
    const slug = slugify(source.slice(0, 60));
    if (slug) return slug.slice(0, 50).replace(/-+$/g, "") || "entry";
  }
  return "entry";
}

function renderDailyBlock(args: {
  slug: string;
  time: string;
  task: string;
  attempts: string[];
  decisions: string[];
  corrections: string[];
}): string {
  const taskSnippet = args.task
    ? args.task.replace(/\s+$/g, "").slice(0, 500)
    : "_(no task)_";
  const latest = (entries: string[]) =>
    entries.length === 0
      ? ["- _(none)_"]
      : entries.slice(-3).map((e) => `- ${firstMeaningfulLine(e)}`);
  const lines: string[] = [
    `## handoff: ${args.slug} — ${args.time}`,
    ``,
    `**Task:**`,
    ``,
    taskSnippet,
    ``,
    `**Counts:** ${args.attempts.length} attempts / ${args.decisions.length} decisions / ${args.corrections.length} corrections`,
    ``,
    `**Latest attempts:**`,
    ...latest(args.attempts),
    ``,
    `**Latest decisions:**`,
    ...latest(args.decisions),
    ``,
    `**Latest corrections:**`,
    ...latest(args.corrections),
    ``,
  ];
  return lines.join("\n");
}

function renderDecisionNote(args: {
  projectPath: string;
  slug: string;
  date: string;
  entry: string;
}): string {
  return [
    `# Decision — ${args.slug}`,
    ``,
    `- **Project**: \`${args.projectPath}\``,
    `- **Date**: ${args.date}`,
    ``,
    args.entry.trim(),
    ``,
  ].join("\n");
}

function renderRuleNote(args: {
  projectPath: string;
  slug: string;
  entry: string;
}): string {
  return [
    `# Rule — ${args.slug}`,
    ``,
    `- **Project**: \`${args.projectPath}\``,
    ``,
    args.entry.trim(),
    ``,
  ].join("\n");
}

/**
 * Write `body` to `path`. If a file exists with different contents, overwrite
 * it and append a "Last synced: <ts>" footer. Returns true if anything was
 * written, false if the existing content already matched.
 */
async function writeIfChanged(path: string, body: string): Promise<boolean> {
  if (await exists(path)) {
    const current = await readOrEmpty(path);
    if (stripSyncedFooter(current).trim() === body.trim()) {
      return false;
    }
    const withFooter = `${body.trimEnd()}\n\n_Last synced: ${new Date().toISOString()}_\n`;
    await writeFileSafe(path, withFooter);
    return true;
  }
  await writeFileSafe(path, body);
  return true;
}

function stripSyncedFooter(s: string): string {
  return s.replace(/\n+_Last synced: [^_]+_\s*$/g, "");
}

function firstMeaningfulLine(entry: string): string {
  const lines = entry.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^##\s+\d{4}-\d{2}-\d{2}T/.test(line)) continue;
    return line.length > 120 ? line.slice(0, 117) + "..." : line;
  }
  return "(empty entry)";
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
