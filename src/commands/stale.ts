import { resolveHandoffPaths, type HandoffPaths } from "../format/paths.js";
import { exists, readOrEmpty } from "../util/fs.js";
import { entryId, isSuperseded, splitEntries } from "./ranking.js";
import { checkEvidence, evidenceEntryFirstLine, type EvidenceCheck } from "./evidence.js";

export type StaleEntry = {
  file: string;
  timestamp: string | null;
  firstLine: string;
  evidence: EvidenceCheck[];
};

export async function collectEvidenceStatus(paths: HandoffPaths): Promise<StaleEntry[]> {
  const results: StaleEntry[] = [];
  for (const file of ["decisions", "corrections", "attempts"] as const) {
    const raw = await readOrEmpty(paths[file]);
    for (const entry of splitEntries(raw).filter((e) => !isSuperseded(e))) {
      const evidence = await checkEvidence(paths.root, entry);
      if (evidence.length > 0) {
        results.push({ file: `${file}.md`, timestamp: entryId(entry),
          firstLine: evidenceEntryFirstLine(entry), evidence });
      }
    }
  }
  return results;
}

export async function stale(opts: { cwd?: string; check?: boolean; json?: boolean } = {}): Promise<void> {
  const paths = resolveHandoffPaths(opts.cwd ?? process.cwd());
  if (!(await exists(paths.dir))) {
    console.error(".handoff/ not initialized. run `handoff init` first.");
    process.exitCode = 1;
    return;
  }
  const entries = await collectEvidenceStatus(paths);
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (entries.length === 0) {
    console.log("No active entries with evidence.");
  } else {
    for (const entry of entries) {
      for (const e of entry.evidence) {
        console.log(`${e.status} ${entry.file} ${entry.timestamp ?? "(undated)"} ${entry.firstLine} — ${e.path}`);
      }
    }
  }
  if (opts.check && entries.some((entry) => entry.evidence.some((e) => e.status !== "OK"))) {
    process.exitCode = 1;
  }
}
