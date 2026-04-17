import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeCursorComposer,
  normalizeToolName,
  CURSOR_TOOL_MAP,
} from "../src/adapters/cursor.js";

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(here, "../../tests/fixtures/cursor-state.vscdb");

const COMPOSER_ID = "cursor01-aaaa-bbbb-cccc-000000000001";
const ERR_COMPOSER_ID = "cursor02-aaaa-bbbb-cccc-000000000002";

function openFixture(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

test("normalizeToolName maps Cursor snake_case to PascalCase Claude vocab", () => {
  assert.equal(normalizeToolName("read_file_v2"), "Read");
  assert.equal(normalizeToolName("edit_file_v2"), "Edit");
  assert.equal(normalizeToolName("run_terminal_command_v2"), "Bash");
  assert.equal(normalizeToolName("glob_file_search"), "Glob");
  assert.equal(normalizeToolName("ripgrep_raw_search"), "Grep");
  assert.equal(normalizeToolName("web_search"), "WebSearch");
  assert.equal(normalizeToolName("web_fetch"), "WebFetch");
  assert.equal(normalizeToolName("delete_file"), "Delete");
  assert.equal(normalizeToolName("todo_write"), "TodoWrite");
  assert.equal(normalizeToolName("task_v2"), "Task");
  // Unknown passes through
  assert.equal(normalizeToolName("some_future_tool"), "some_future_tool");
  // Undefined → "Unknown"
  assert.equal(normalizeToolName(undefined), "Unknown");
});

test("CURSOR_TOOL_MAP includes all known Cursor tools", () => {
  // Lock the table — if it's tampered with silently, we catch it
  const required = [
    "read_file_v2",
    "edit_file_v2",
    "glob_file_search",
    "ripgrep_raw_search",
    "run_terminal_command_v2",
    "web_search",
    "web_fetch",
    "delete_file",
    "todo_write",
    "task_v2",
  ];
  for (const k of required) {
    assert.ok(k in CURSOR_TOOL_MAP, `${k} missing from CURSOR_TOOL_MAP`);
  }
});

test("summarizeCursorComposer renders standard section structure", () => {
  const db = openFixture();
  try {
    const out = summarizeCursorComposer(db, COMPOSER_ID, DB_PATH, "C:\\Users\\test\\proj");

    // H1
    assert.match(out, /^# Cursor Session: cursor01/m);
    assert.match(out, /\*\*Session ID\*\*: `cursor01-aaaa-bbbb-cccc-000000000001`/);
    assert.match(out, /\*\*Project cwd\*\*: `C:\\Users\\test\\proj`/);

    // Standard section order
    const userIdx = out.indexOf("## User messages (chronological)");
    const toolIdx = out.indexOf("## Tool activity");
    const finalIdx = out.indexOf("## Assistant's final messages");
    assert.ok(userIdx > 0);
    assert.ok(toolIdx > userIdx);
    assert.ok(finalIdx > toolIdx);

    // User messages
    assert.match(out, /Please read src\/index\.ts/);
    assert.match(out, /Now run the tests/);

    // Normalized tool names (not snake_case)
    assert.match(out, /- Read: 1/);
    assert.match(out, /- Bash: 1/);
    assert.match(out, /- Edit: 1/);
    assert.doesNotMatch(out, /read_file_v2/);
    assert.doesNotMatch(out, /run_terminal_command_v2/);
    assert.doesNotMatch(out, /edit_file_v2/);

    // Edit captured in filesTouched
    assert.match(out, /### Files written\/edited/);
    assert.match(out, /`README\.md`/);

    // Bash command captured
    assert.match(out, /### Bash commands/);
    assert.match(out, /`npm test`/);

    // Final assistant message
    assert.match(out, /Tests passed and README updated\./);
  } finally {
    db.close();
  }
});

test("summarizeCursorComposer: error-status tool triggers error section", () => {
  const db = openFixture();
  try {
    const out = summarizeCursorComposer(db, ERR_COMPOSER_ID, DB_PATH, null);
    assert.match(out, /## Errors hit/);
    assert.match(out, /\*\*Delete\*\*: file not found/);
  } finally {
    db.close();
  }
});

test("summarizeCursorComposer: unknown composer id produces empty-state summary (no crash)", () => {
  const db = openFixture();
  try {
    const out = summarizeCursorComposer(
      db,
      "nonexistent-composer-id",
      DB_PATH,
      null,
    );
    // Falls through to empty render — no crash
    assert.match(out, /^# Cursor Session: nonexist/m);
    assert.match(out, /\*\*User messages\*\*: 0/);
    assert.match(out, /_\(none\)_/);
  } finally {
    db.close();
  }
});

test("missing DB path throws, does not silently corrupt", () => {
  assert.throws(() => {
    new DatabaseSync("C:/definitely/not/real/cursor.vscdb", { readOnly: true });
  });
});
