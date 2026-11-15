import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { entryId, isSuperseded, splitEntries } from "./ranking.js";

export type Evidence = { path: string; hash: string };
export type EvidenceStatus = "OK" | "CHANGED" | "MISSING";
export type EvidenceCheck = Evidence & { status: EvidenceStatus; currentHash?: string };
export const STALE_ANNOTATION = " (evidence changed: re-check before trusting)";

class EvidencePathError extends Error {}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new EvidencePathError("Evidence path must stay inside the repository root.");
  }
}

async function hashFile(root: string, path: string): Promise<Evidence> {
  if (!path || /[\r\n]/.test(path)) {
    throw new EvidencePathError("Evidence paths must be non-empty single lines.");
  }
  const absolute = resolve(root, path);
  assertInside(resolve(root), absolute);
  // Check real paths too: a symlink in the repository must not read outside it.
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(absolute);
  assertInside(realRoot, realFile);
  if (!(await fs.stat(realFile)).isFile()) {
    throw new EvidencePathError("Evidence must be a regular file.");
  }
  const hash = createHash("sha256").update(await fs.readFile(realFile)).digest("hex").slice(0, 16);
  return { path: relative(resolve(root), absolute).split(sep).join("/"), hash };
}

/** Validate and hash all inputs before either log can revoke or append anything. */
export async function captureEvidence(root: string, paths: string[] = []): Promise<string[]> {
  const evidence = await Promise.all(paths.map((path) => hashFile(root, path)));
  return evidence.map((e) => `**evidence:** ${e.path}@sha256:${e.hash}`);
}

export function parseEvidence(entry: string): Evidence[] {
  return [...entry.matchAll(/^\*\*evidence:\*\* (.+)@sha256:([a-f0-9]{16})\r?$/gm)]
    .map((m) => ({ path: m[1]!, hash: m[2]! }));
}

export async function checkEvidence(root: string, entry: string): Promise<EvidenceCheck[]> {
  return Promise.all(parseEvidence(entry).map(async (e): Promise<EvidenceCheck> => {
    try {
      const current = await hashFile(root, e.path);
      return { ...e, status: current.hash === e.hash ? "OK" : "CHANGED", currentHash: current.hash };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { ...e, status: "MISSING" };
      // A file replaced by a directory or an out-of-root symlink is changed.
      if (error instanceof EvidencePathError) return { ...e, status: "CHANGED" };
      throw error;
    }
  }));
}

export async function staleEntryIds(root: string, raw: string): Promise<Set<string | null>> {
  const stale = new Set<string | null>();
  for (const entry of splitEntries(raw).filter((e) => !isSuperseded(e))) {
    if ((await checkEvidence(root, entry)).some((e) => e.status !== "OK")) {
      stale.add(entryId(entry));
    }
  }
  return stale;
}

/** First content line, excluding timestamp and provenance fields. */
export function evidenceEntryFirstLine(entry: string): string {
  return entry.split("\n").find((line) => line.trim() &&
    !/^#|^---|^\*\*(?:key|source|evidence|superseded|revoked-by|revoked-at):\*\*/i.test(line)) ?? "";
}

/** Preserve the full log's formatting; only stale active entries gain a suffix. */
export async function annotateEvidence(root: string, raw: string): Promise<string> {
  const stale = await staleEntryIds(root, raw);
  if (stale.size === 0) return raw;
  return raw.split(/(?=^## )/m).map((block) => {
    if (isSuperseded(block) || !stale.has(entryId(block))) return block;
    const firstLine = evidenceEntryFirstLine(block);
    return firstLine ? block.replace(firstLine, firstLine + STALE_ANNOTATION) : block;
  }).join("");
}
