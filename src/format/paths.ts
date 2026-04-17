import { resolve } from "node:path";

export type HandoffPaths = {
  root: string;
  dir: string;
  handoffMd: string;
  ingestedContext: string;
  task: string;
  progress: string;
  decisions: string;
  attempts: string;
  corrections: string;
  identity: string;
  environment: string;
  codebaseMap: string;
  openLoops: string;
  references: string;
  toolHistory: string;
  transcript: string;
  filesManifest: string;
  meta: string;
};

export function resolveHandoffPaths(cwd: string = process.cwd()): HandoffPaths {
  const root = cwd;
  const dir = resolve(root, ".handoff");
  return {
    root,
    dir,
    handoffMd: resolve(dir, "HANDOFF.md"),
    ingestedContext: resolve(dir, "ingested-context.md"),
    task: resolve(dir, "task.md"),
    progress: resolve(dir, "progress.md"),
    decisions: resolve(dir, "decisions.md"),
    attempts: resolve(dir, "attempts.md"),
    corrections: resolve(dir, "corrections.md"),
    identity: resolve(dir, "identity.md"),
    environment: resolve(dir, "environment.md"),
    codebaseMap: resolve(dir, "codebase-map.md"),
    openLoops: resolve(dir, "open-loops.md"),
    references: resolve(dir, "references.md"),
    toolHistory: resolve(dir, "tool-history.jsonl"),
    transcript: resolve(dir, "transcript.jsonl"),
    filesManifest: resolve(dir, "files.json"),
    meta: resolve(dir, "meta.json"),
  };
}
