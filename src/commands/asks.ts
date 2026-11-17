import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { HandoffPaths } from "../format/paths.js";
import { withFileLock } from "../util/lock.js";
import { tryGit } from "../util/git.js";
import { isSideAsk } from "./ask-detection.js";

const ASK_ID = "ask-[0-9a-f]{16}";
const issueId = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
const header = /^- \[ \] (ask-[0-9a-f]{16}) \| (\d{4}-\d\d-\d\dT[0-9:.]+Z) \| claude-code \| session (\S+)(\r?\n)((?:  > [^\n]*\n)+)<!-- end handoff ask -->(?:\r?\n|$)/gm;

type Ask = { id: string; date: string; session: string; prompt: string; block: string };
type Evidence = { kind: "user" | "linear" | "commit"; value: string };
type Receipt = { id: string; date: string; session: string; tool: string; prompt: string; resolvedAt: string; evidence: Evidence };

export function readAsks(markdown: string): Ask[] {
  const asks: Ask[] = [];
  for (const [block, id, date, session, eol, quote] of markdown.matchAll(header)) {
    try {
      asks.push({ id, date, session: decodeURIComponent(session), block,
        prompt: quote.slice(0, -eol.length).split(eol).map(line => line.slice(4)).join("\n") });
    } catch {
      // A manually edited header can contain invalid percent escapes.
    }
  }
  return asks;
}

// An unreadable file must never be mistaken for an empty file during an update.
async function readOptional(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function replaceFile(path: string, text: string): Promise<void> {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    const prior = await fs.stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    await fs.writeFile(temp, text, { flag: "wx", mode: 0o600 });
    if (prior) await fs.chmod(temp, prior.mode & 0o777);
    await fs.rename(temp, path);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function historyPath(paths: HandoffPaths): string {
  return join(paths.dir, "ask-history.jsonl");
}

async function history(paths: HandoffPaths): Promise<Receipt[]> {
  return (await readOptional(historyPath(paths))).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

type Resolution = { ask: Ask; evidence: Evidence };

// Called with the open-loops lock. Persist the receipt before removing the
// active quote. A retry after interruption finishes removal without a second receipt.
async function close(paths: HandoffPaths, markdown: string, items: Resolution[]): Promise<void> {
  if (!items.length) return;
  const receipts = await history(paths);
  for (const { ask, evidence } of items) {
    if (!receipts.some(r => r.id === ask.id)) {
      receipts.push({ id: ask.id, date: ask.date, session: ask.session, tool: "claude-code",
        prompt: ask.prompt, resolvedAt: new Date().toISOString(), evidence });
    }
    markdown = markdown.replace(ask.block, "");
  }
  await replaceFile(historyPath(paths), receipts.map(r => JSON.stringify(r)).join("\n") + "\n");
  await replaceFile(paths.openLoops, markdown);
}

export async function fileAsk(paths: HandoffPaths, id: string, issue: string): Promise<void> {
  if (!(await fs.stat(paths.dir).catch(() => null))?.isDirectory()) throw new Error("No .handoff directory");
  if (!issueId.test(issue)) throw new Error("Expected a Linear issue ID such as ZOH-123");
  await withFileLock(paths.openLoops, async () => {
    const markdown = await readOptional(paths.openLoops);
    const ask = readAsks(markdown).find(a => a.id === id);
    if (!ask) {
      if ((await history(paths)).some(r => r.id === id && r.evidence.kind === "linear" && r.evidence.value === issue)) return;
      throw new Error("No matching open ask");
    }
    await close(paths, markdown, [{ ask, evidence: { kind: "linear", value: issue } }]);
  });
}

const byId = new RegExp(`^(?:please )?(?:close|drop|cancel|resolve) (?:the (?:open )?(?:loop|ask) )?(${ASK_ID})[.!]?$|^(${ASK_ID}) is (?:done|finished|resolved)[.!]?$`, "i");
const filed = new RegExp(`^(?:I |we )?(?:filed|tracked) (${ASK_ID}) (?:as|in) ([A-Z][A-Z0-9]*-[1-9]\\d*)[.!]?$`, "i");
const byReference = /^(?:(?:please )?(?:close|drop|cancel) (?:that|the last) (?:open loop|ask)|that (?:open loop|ask) is (?:done|finished|resolved))[.!]?$/i;

export async function capturePrompt(paths: HandoffPaths, prompt: string, session: string, inFlight: boolean, promptId?: string): Promise<void> {
  const words = prompt.trim();
  const explicit = words.match(byId);
  const linked = words.match(filed);
  const last = byReference.test(words);
  if (!explicit && !linked && !last && !isSideAsk(prompt, inFlight)) return;

  await withFileLock(paths.openLoops, async () => {
    const markdown = await readOptional(paths.openLoops);
    const asks = readAsks(markdown);
    if (explicit || linked || last) {
      const id = (explicit?.[1] ?? explicit?.[2] ?? linked?.[1])?.toLowerCase();
      const matches = id ? asks.filter(a => a.id === id) : asks.filter(a => a.session === session);
      if (matches.length === 1) {
        const evidence: Evidence = linked ? { kind: "linear", value: linked[2].toUpperCase() } : { kind: "user", value: prompt };
        await close(paths, markdown, [{ ask: matches[0], evidence }]);
      }
      return;
    }
    if (asks.some(a => a.session === session && a.prompt === prompt)) return;
    const receipts = await history(paths);
    // On older clients a fresh submission after closure must be capturable.
    const identity = promptId ? [session, "event", promptId] :
      [session, "text", prompt, receipts.filter(r => r.session === session && r.prompt === prompt).length];
    const id = "ask-" + createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
    if (asks.some(a => a.id === id) || receipts.some(r => r.id === id)) return;
    const quote = prompt.split("\n").map(line => "  > " + line).join("\n");
    const entry = `- [ ] ${id} | ${new Date().toISOString()} | claude-code | session ${encodeURIComponent(session)}\n${quote}\n<!-- end handoff ask -->\n`;
    await replaceFile(paths.openLoops, markdown + (markdown.endsWith("\n") || !markdown ? "" : "\n") + "\n" + entry);
  });
}

// Require a real Git trailer identifying the ask. A coincidental keyword in a
// subject, diff or branch name cannot close one.
export async function reconcileCommits(paths: HandoffPaths): Promise<void> {
  const snapshot = readAsks(await readOptional(paths.openLoops));
  if (!snapshot.length) return;
  const since = Math.min(...snapshot.map(a => Date.parse(a.date))) / 1000;
  const log = await tryGit(["log", "--no-notes", "--no-show-signature", "--regexp-ignore-case",
    "--grep=^Resolves-Ask:", `--since=@${Math.floor(since) - 1}`,
    "--format=%H%x09%ct%x09%(trailers:key=Resolves-Ask,valueonly,separator=%x2C)", "HEAD"], paths.root);
  if (!log) return;
  const resolved = new Map<string, string>();
  for (const line of log.split("\n")) {
    const [sha, time, ids] = line.split("\t");
    for (const id of (ids ?? "").split(",")) {
      const ask = snapshot.find(a => a.id === id.trim());
      if (ask && Number(time) >= Math.floor(Date.parse(ask.date) / 1000)) resolved.set(ask.id, sha);
    }
  }
  if (!resolved.size) return;
  await withFileLock(paths.openLoops, async () => {
    const markdown = await readOptional(paths.openLoops);
    const items: Resolution[] = [];
    for (const ask of readAsks(markdown)) {
      const sha = resolved.get(ask.id);
      if (sha) items.push({ ask, evidence: { kind: "commit", value: sha } });
    }
    await close(paths, markdown, items);
  });
}

export function sessionFromPayload(id: unknown, transcript: unknown): string | undefined {
  if (typeof id === "string" && id.trim()) return id;
  if (typeof transcript === "string" && transcript) return basename(transcript, ".jsonl") || undefined;
  return undefined;
}
