import { resolveHandoffPaths } from "../format/paths.js";
import { appendLine, exists, readOrEmpty } from "../util/fs.js";
import { withFileLock } from "../util/lock.js";
import { splitEntries, isSuperseded } from "./ranking.js";

export interface WikiEntry {
  title: string;
  body: string;
  addedAt: string;
}

export interface WikiDistillResult {
  added: number;
  skipped: number;
  entries: WikiEntry[];
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

type WikiAddOpts = {
  title: string;
  body: string;
  cwd?: string;
};

export async function wikiAdd(opts: WikiAddOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }

  const ts = new Date().toISOString();
  const entry = formatWikiEntry({ title: opts.title, body: opts.body, addedAt: ts });

  await withFileLock(paths.wiki, async () => {
    await appendLine(paths.wiki, "\n" + entry);
  });

  console.log(`wiki entry added at ${ts}`);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

type WikiListOpts = {
  cwd?: string;
};

export async function wikiList(opts: WikiListOpts = {}): Promise<WikiEntry[]> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return [];
  }

  const raw = await readOrEmpty(paths.wiki);
  const entries = parseWikiEntries(raw);

  if (entries.length === 0) {
    console.log("No wiki entries yet. Use `handoff wiki add` or `handoff wiki distill`.");
  } else {
    console.log(`${entries.length} wiki entr${entries.length === 1 ? "y" : "ies"}:`);
    for (const e of entries) {
      console.log(`\n### ${e.title}  _(${e.addedAt})_\n${e.body}`);
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Distill  (experience → wiki)
//
// WikiSkill (arXiv 2608.27454): distill raw agent experience into a persistent
// wiki so that future agents benefit from synthesized, general knowledge rather
// than having to re-read raw incident logs.
//
// This implementation extracts the **lesson:** field from each corrections.md
// entry and writes one wiki entry per unique lesson that is not already present
// in wiki.md.  No LLM calls — the lesson field is the agent's own synthesis,
// kept verbatim.
// ---------------------------------------------------------------------------

type WikiDistillOpts = {
  cwd?: string;
  dryRun?: boolean;
};

export async function wikiDistill(opts: WikiDistillOpts = {}): Promise<WikiDistillResult> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return { added: 0, skipped: 0, entries: [] };
  }

  // corrections.md is a stable input here (distill never writes it), so it can
  // be read outside the lock. wiki.md must not: the read, the dedup decision,
  // and the append have to be one atomic read-modify-write, or two concurrent
  // `distill` runs each read the same pre-update wiki, both decide the same
  // lessons are missing, and serialize only their appends — producing duplicate
  // durable entries despite the idempotence guarantee.
  const correctionsRaw = await readOrEmpty(paths.corrections);
  const lessons = extractLessons(correctionsRaw);
  const ts = new Date().toISOString();

  const computeToAdd = (wikiRaw: string): WikiEntry[] => {
    const existingBodies = new Set(
      parseWikiEntries(wikiRaw).map((e) => normalizeLesson(e.body)),
    );
    const out: WikiEntry[] = [];
    for (const lesson of lessons) {
      const normalized = normalizeLesson(lesson);
      if (existingBodies.has(normalized)) continue;
      // Deduplicate within this batch too.
      if (out.some((e) => normalizeLesson(e.body) === normalized)) continue;
      out.push({ title: deriveTitle(lesson), body: lesson, addedAt: ts });
      existingBodies.add(normalized);
    }
    return out;
  };

  let toAdd: WikiEntry[];
  if (opts.dryRun) {
    // No write, so no lock: just report what a real run would add right now.
    toAdd = computeToAdd(await readOrEmpty(paths.wiki));
  } else {
    // Re-read, dedup, and append as one operation under the lock.
    toAdd = await withFileLock(paths.wiki, async () => {
      const entries = computeToAdd(await readOrEmpty(paths.wiki));
      if (entries.length > 0) {
        const block = entries.map((e) => "\n" + formatWikiEntry(e)).join("");
        await appendLine(paths.wiki, block);
      }
      return entries;
    });
  }

  const skipped = lessons.length - toAdd.length;
  if (opts.dryRun) {
    console.log(`[dry-run] would add ${toAdd.length} entr${toAdd.length === 1 ? "y" : "ies"}, skip ${skipped} duplicate${skipped === 1 ? "" : "s"}`);
    for (const e of toAdd) console.log(`  + ${e.title}`);
  } else {
    console.log(`distilled ${toAdd.length} entr${toAdd.length === 1 ? "y" : "ies"} from corrections, skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}`);
    for (const e of toAdd) console.log(`  + ${e.title}`);
  }

  return { added: toAdd.length, skipped, entries: toAdd };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWikiEntry(e: WikiEntry): string {
  return [
    `## ${e.title}`,
    ``,
    `_Added: ${e.addedAt}_`,
    ``,
    e.body,
    ``,
    `---`,
    ``,
  ].join("\n");
}

/**
 * Parse wiki.md into structured entries. Each entry starts with ## <title>
 * and ends at the next ## or end-of-file.
 */
export function parseWikiEntries(raw: string): WikiEntry[] {
  const entries: WikiEntry[] = [];
  // Split on ## headings (H2 = entry start)
  const sections = raw.split(/\n(?=## )/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    const titleLine = lines[0] ?? "";
    if (!titleLine.startsWith("## ")) continue;
    const title = titleLine.replace(/^## /, "").trim();

    // Extract addedAt from the "_Added: ISO_" line
    let addedAt = "";
    const addedMatch = trimmed.match(/_Added:\s*([^\n_]+)_/);
    if (addedMatch) addedAt = addedMatch[1]!.trim();

    // Body: everything after the title and addedAt line, before the trailing ---
    const bodyRaw = lines.slice(1).join("\n")
      .replace(/_Added:[^\n]*_\n?/, "")
      .replace(/\n---\s*$/, "")
      .trim();

    if (!title || !bodyRaw) continue;
    entries.push({ title, body: bodyRaw, addedAt });
  }
  return entries;
}

/**
 * Extract the **lesson:** value from each corrections.md entry.
 * Lesson lines look like: `**lesson:** some text`
 *
 * Superseded entries are skipped. When a keyed correction is replaced,
 * `revokeActiveByKey` leaves the old entry in place with a `**superseded:** true`
 * marker for audit — the same treatment ranking, retrieval, and constraint
 * extraction give it. Promoting an obsolete lesson into the durable wiki would
 * resurrect a rule the user has already retired, so we split into entries and
 * drop the superseded ones before pulling lessons.
 */
export function extractLessons(correctionsRaw: string): string[] {
  const lessons: string[] = [];
  const lessonRe = /^\*\*lesson:\*\*\s+(.+)/gm;
  for (const entry of splitEntries(correctionsRaw)) {
    if (isSuperseded(entry)) continue;
    let m: RegExpExecArray | null;
    lessonRe.lastIndex = 0;
    while ((m = lessonRe.exec(entry)) !== null) {
      const lesson = m[1]!.trim();
      if (lesson) lessons.push(lesson);
    }
  }
  return lessons;
}

/** Title is the first sentence (up to '.', '!', or '?' or 60 chars). */
function deriveTitle(lesson: string): string {
  const match = lesson.match(/^[^.!?]{1,60}[.!?]?/);
  const raw = match ? match[0].trim() : lesson.slice(0, 60).trim();
  // Capitalise first letter
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Normalize for dedup: lowercase, collapse whitespace. */
function normalizeLesson(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
