import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeSession } from "../src/commands/ingest.js";
import { summarizeCursorComposer } from "../src/adapters/cursor.js";

const here = dirname(fileURLToPath(import.meta.url));
const JSONL_FIXTURE = resolve(here, "../../tests/fixtures/claude-code-session.jsonl");
const DB_FIXTURE = resolve(here, "../../tests/fixtures/cursor-state.vscdb");
const COMPOSER_ID = "cursor01-aaaa-bbbb-cccc-000000000001";

/**
 * Extract top-level (##) section headers in the order they appear.
 * We deliberately ignore H1/H3 — downstream tools key off H2 blocks.
 */
function h2Sections(md: string): string[] {
  return md
    .split("\n")
    .filter((l) => /^## /.test(l))
    .map((l) => l.trim());
}

/** Extract H3 subheaders in order. */
function h3Sections(md: string): string[] {
  return md
    .split("\n")
    .filter((l) => /^### /.test(l))
    .map((l) => l.trim());
}

test("claude-code and cursor outputs share identical ## section structure", async () => {
  const claudeMd = await summarizeSession(JSONL_FIXTURE);
  const db = new DatabaseSync(DB_FIXTURE, { readOnly: true });
  let cursorMd: string;
  try {
    cursorMd = summarizeCursorComposer(db, COMPOSER_ID, DB_FIXTURE, null);
  } finally {
    db.close();
  }

  const claudeH2 = h2Sections(claudeMd);
  const cursorH2 = h2Sections(cursorMd);

  // Contract: both emit these exact H2 headers in this order (when content present)
  // Claude fixture has errors, cursor (COMPOSER_ID) does not. Compare only shared headers.
  const sharedExpected = [
    "## User messages (chronological)",
    "## Tool activity",
    "## Assistant's final messages",
  ];
  for (const h of sharedExpected) {
    assert.ok(
      claudeH2.includes(h),
      `claude-code output missing required section: ${h}`,
    );
    assert.ok(
      cursorH2.includes(h),
      `cursor output missing required section: ${h}`,
    );
  }

  // Order contract: user → tool → final must appear in that order in BOTH
  const orderedFilter = (arr: string[], wanted: string[]) =>
    arr.filter((h) => wanted.includes(h));
  assert.deepEqual(
    orderedFilter(claudeH2, sharedExpected),
    sharedExpected,
    "claude-code emits required sections in expected order",
  );
  assert.deepEqual(
    orderedFilter(cursorH2, sharedExpected),
    sharedExpected,
    "cursor emits required sections in expected order",
  );
});

test("both outputs place tool subsections under ## Tool activity", async () => {
  const claudeMd = await summarizeSession(JSONL_FIXTURE);
  const db = new DatabaseSync(DB_FIXTURE, { readOnly: true });
  let cursorMd: string;
  try {
    cursorMd = summarizeCursorComposer(db, COMPOSER_ID, DB_FIXTURE, null);
  } finally {
    db.close();
  }

  for (const [label, md] of [
    ["claude-code", claudeMd],
    ["cursor", cursorMd],
  ]) {
    const toolIdx = md.indexOf("## Tool activity");
    const finalIdx = md.indexOf("## Assistant's final messages");
    // Subsections must live between ## Tool activity and the next ## block
    const filesIdx = md.indexOf("### Files written/edited");
    const bashIdx = md.indexOf("### Bash commands");
    assert.ok(filesIdx > toolIdx && filesIdx < finalIdx, `${label}: Files subsection within Tool activity`);
    assert.ok(bashIdx > toolIdx && bashIdx < finalIdx, `${label}: Bash subsection within Tool activity`);
  }
});

test("both outputs start with the same H1 shape: `# <Source> Session: <short-id>`", async () => {
  const claudeMd = await summarizeSession(JSONL_FIXTURE);
  const db = new DatabaseSync(DB_FIXTURE, { readOnly: true });
  let cursorMd: string;
  try {
    cursorMd = summarizeCursorComposer(db, COMPOSER_ID, DB_FIXTURE, null);
  } finally {
    db.close();
  }
  assert.match(claudeMd, /^# Claude Code Session: [a-f0-9]{8}/m);
  assert.match(cursorMd, /^# Cursor Session: [a-z0-9-]+/m);
});

test("both outputs emit the same metadata fields in the same order", async () => {
  const claudeMd = await summarizeSession(JSONL_FIXTURE);
  const db = new DatabaseSync(DB_FIXTURE, { readOnly: true });
  let cursorMd: string;
  try {
    cursorMd = summarizeCursorComposer(db, COMPOSER_ID, DB_FIXTURE, null);
  } finally {
    db.close();
  }

  // Strip the metadata block: everything between H1 and first ## header
  const metaFields = (md: string) => {
    const afterH1 = md.slice(md.indexOf("\n"));
    const block = afterH1.slice(0, afterH1.indexOf("## "));
    return block
      .split("\n")
      .filter((l) => /^- \*\*/.test(l))
      .map((l) => l.match(/^- \*\*([^*]+)\*\*/)?.[1])
      .filter((s): s is string => Boolean(s));
  };

  const claudeFields = metaFields(claudeMd);
  const cursorFields = metaFields(cursorMd);
  assert.deepEqual(
    claudeFields,
    cursorFields,
    "metadata field order must match across sources",
  );
  // Sanity: the fields are the ones we expect
  assert.deepEqual(claudeFields, [
    "Session ID",
    "Project cwd",
    "Started",
    "Ended",
    "Duration",
    "User messages",
    "Assistant turns",
    "Source file",
  ]);
});
