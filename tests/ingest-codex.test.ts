import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeCodexSession,
  normalizeCodexToolName,
  CODEX_TOOL_MAP,
} from "../src/adapters/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
// `here` at runtime is dist/tests/ — fixtures sit next to the source at tests/fixtures/
const FIXTURE = resolve(here, "../../tests/fixtures/codex-session.jsonl");

test("normalizeCodexToolName maps Codex names to PascalCase Claude vocab", () => {
  assert.equal(normalizeCodexToolName("read_file"), "Read");
  assert.equal(normalizeCodexToolName("write_file"), "Edit");
  assert.equal(normalizeCodexToolName("apply_patch"), "Edit");
  assert.equal(normalizeCodexToolName("shell"), "Bash");
  assert.equal(normalizeCodexToolName("shell_command"), "Bash");
  assert.equal(normalizeCodexToolName("exec_command"), "Bash");
  assert.equal(normalizeCodexToolName("search"), "Grep");
  assert.equal(normalizeCodexToolName("grep"), "Grep");
  assert.equal(normalizeCodexToolName("glob"), "Glob");
  assert.equal(normalizeCodexToolName("update_plan"), "TodoWrite");
  assert.equal(normalizeCodexToolName("web_search"), "WebSearch");
  assert.equal(normalizeCodexToolName("web_fetch"), "WebFetch");
  // Unknown passes through
  assert.equal(normalizeCodexToolName("future_tool"), "future_tool");
  // Undefined → "Unknown"
  assert.equal(normalizeCodexToolName(undefined), "Unknown");
});

test("CODEX_TOOL_MAP includes the top-6 entries the research called out", () => {
  const required = [
    "read_file",
    "write_file",
    "apply_patch",
    "shell",
    "update_plan",
    "web_search",
  ];
  for (const k of required) {
    assert.ok(k in CODEX_TOOL_MAP, `${k} missing from CODEX_TOOL_MAP`);
  }
});

test("summarizeCodexSession parses JSONL and renders all expected sections", async () => {
  const out = await summarizeCodexSession(FIXTURE);

  // H1 heading
  assert.match(out, /^# Codex Session: 019d9000/m);
  // Metadata line — session_meta-derived id and cwd
  assert.match(out, /\*\*Session ID\*\*: `019d9000-aaaa-7000-bbbb-cccccccccccc`/);
  assert.match(out, /\*\*Project cwd\*\*: `C:\\Users\\test\\proj`/);

  // Section headers in order
  const userIdx = out.indexOf("## User messages (chronological)");
  const toolIdx = out.indexOf("## Tool activity");
  const finalIdx = out.indexOf("## Assistant's final messages");
  assert.ok(userIdx > 0);
  assert.ok(toolIdx > userIdx);
  assert.ok(finalIdx > toolIdx);

  // User count: 2 real user messages (environment_context wrapper skipped)
  assert.match(out, /\*\*User messages\*\*: 2/);
  assert.match(out, /Please fix the typo in README\.md/);
  assert.match(out, /Try again with the right permissions/);
  // Wrapper messages should NOT leak into user output
  assert.doesNotMatch(out, /<environment_context>/);

  // Normalized tool names (not raw codex names)
  assert.match(out, /- Read: 1/);
  assert.match(out, /- Bash: 1/);
  assert.match(out, /- Edit: 1/);
  assert.match(out, /- TodoWrite: 1/);
  assert.doesNotMatch(out, /- shell_command:/);
  assert.doesNotMatch(out, /- apply_patch:/);

  // apply_patch file extraction
  assert.match(out, /### Files written\/edited/);
  assert.match(out, /`C:\\Users\\test\\proj\\README\.md`/);

  // Bash command captured
  assert.match(out, /### Bash commands/);
  assert.match(out, /`ls -la`/);

  // Final assistant message captured
  assert.match(out, /All set\. Let me know if you need anything else\./);
});

test("summarizeCodexSession: function_call_output with error surfaces in errors section", async () => {
  const out = await summarizeCodexSession(FIXTURE);
  assert.match(out, /## Errors hit/);
  // apply_patch is normalized to Edit and its non-zero exit is reported
  assert.match(out, /\*\*Edit\*\*:.*Exit code: 1/);
});

test("summarizeCodexSession: missing file produces a well-formed empty summary (no throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-codex-missing-"));
  const file = join(dir, "does-not-exist.jsonl");
  try {
    const out = await summarizeCodexSession(file);
    assert.match(out, /^# Codex Session:/m);
    assert.match(out, /\*\*User messages\*\*: 0/);
    assert.match(out, /\*\*Assistant turns\*\*: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeCodexSession: tolerates malformed trailing JSON (rollout mid-write)", async () => {
  // Fixture's final lines are a literal malformed line and a truncated
  // response_item — neither should throw, and real content before them
  // should still be counted.
  const out = await summarizeCodexSession(FIXTURE);
  assert.ok(out.length > 0);
  assert.match(out, /\*\*User messages\*\*: 2/);
});

test("summarizeCodexSession: empty file returns a well-formed empty summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-codex-empty-"));
  const file = join(dir, "empty.jsonl");
  writeFileSync(file, "", "utf8");
  try {
    const out = await summarizeCodexSession(file);
    assert.match(out, /^# Codex Session:/m);
    assert.match(out, /\*\*User messages\*\*: 0/);
    assert.match(out, /\*\*Assistant turns\*\*: 0/);
    assert.match(out, /_\(none\)_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
