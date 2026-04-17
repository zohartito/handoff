import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeGeminiChat,
  normalizeGeminiToolName,
  GEMINI_TOOL_MAP,
} from "../src/adapters/gemini.js";

const here = dirname(fileURLToPath(import.meta.url));
// tests are compiled into dist/tests; fixtures live beside the source.
const FIXTURE = resolve(here, "../../tests/fixtures/gemini-checkpoint.json");

function loadFixture(): any[] {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

test("normalizeGeminiToolName maps Gemini snake_case to PascalCase", () => {
  assert.equal(normalizeGeminiToolName("read_file"), "Read");
  assert.equal(normalizeGeminiToolName("read_many_files"), "Read");
  assert.equal(normalizeGeminiToolName("write_file"), "Write");
  assert.equal(normalizeGeminiToolName("edit_file"), "Edit");
  assert.equal(normalizeGeminiToolName("run_shell_command"), "Bash");
  assert.equal(normalizeGeminiToolName("glob_files"), "Glob");
  assert.equal(normalizeGeminiToolName("list_directory"), "Glob");
  assert.equal(normalizeGeminiToolName("grep_files"), "Grep");
  assert.equal(normalizeGeminiToolName("web_search"), "WebSearch");
  assert.equal(normalizeGeminiToolName("web_fetch"), "WebFetch");
  // Unknown passes through
  assert.equal(normalizeGeminiToolName("some_future_gemini_tool"), "some_future_gemini_tool");
  // Undefined → "Unknown"
  assert.equal(normalizeGeminiToolName(undefined), "Unknown");
});

test("GEMINI_TOOL_MAP covers the core tool vocabulary", () => {
  const required = [
    "read_file",
    "write_file",
    "edit_file",
    "run_shell_command",
    "glob_files",
    "grep_files",
  ];
  for (const k of required) {
    assert.ok(k in GEMINI_TOOL_MAP, `${k} missing from GEMINI_TOOL_MAP`);
  }
});

test("summarizeGeminiChat renders the shared section structure", () => {
  const chat = loadFixture();
  const out = summarizeGeminiChat(FIXTURE, chat, "C:\\Users\\test\\proj");

  // H1 — derived from filename, strips `checkpoint-` if present
  assert.match(out, /^# Gemini Session: /m);
  assert.match(out, /\*\*Project cwd\*\*: `C:\\Users\\test\\proj`/);

  // Standard H2 section order (parity with Claude Code + Cursor)
  const userIdx = out.indexOf("## User messages (chronological)");
  const toolIdx = out.indexOf("## Tool activity");
  const finalIdx = out.indexOf("## Assistant's final messages");
  assert.ok(userIdx > 0, "user messages section present");
  assert.ok(toolIdx > userIdx, "tool activity after user messages");
  assert.ok(finalIdx > toolIdx, "final messages after tool activity");
});

test("summarizeGeminiChat counts only REAL user messages, not functionResponse", () => {
  const chat = loadFixture();
  const out = summarizeGeminiChat(FIXTURE, chat, null);

  // Fixture has 2 real user text messages; 4 functionResponse entries
  // (which are ALSO role:"user" but are tool results).
  // If we naively counted every role:"user", we'd get 6.
  assert.match(out, /\*\*User messages\*\*: 2/);
  assert.doesNotMatch(out, /\*\*User messages\*\*: 6/);

  // User message bodies present
  assert.match(out, /Please read src\/index\.ts/);
  assert.match(out, /Try again after I fixed the permissions/);
});

test("summarizeGeminiChat: tool counts use normalized PascalCase names", () => {
  const chat = loadFixture();
  const out = summarizeGeminiChat(FIXTURE, chat, null);

  // Fixture: 2x read_file, 1x run_shell_command, 1x edit_file
  assert.match(out, /- Read: 2/);
  assert.match(out, /- Bash: 1/);
  assert.match(out, /- Edit: 1/);

  // Raw snake_case must NOT leak through
  assert.doesNotMatch(out, /read_file/);
  assert.doesNotMatch(out, /run_shell_command/);
  assert.doesNotMatch(out, /edit_file/);
});

test("summarizeGeminiChat: functionResponse with `error` field triggers an error entry", () => {
  const chat = loadFixture();
  const out = summarizeGeminiChat(FIXTURE, chat, null);

  assert.match(out, /## Errors hit/);
  // The edit_file functionResponse has `{error: "permission denied: ..."}`
  assert.match(out, /\*\*Edit\*\*: permission denied/);
});

test("summarizeGeminiChat: consecutive model messages and tool calls collapse correctly", () => {
  // Minimal synthetic case: two back-to-back model messages with tool calls,
  // no user message between. Should collapse into ONE assistant turn with
  // multiple toolUses, and the turn count should be 1 not 2.
  const chat: any[] = [
    { role: "user", parts: [{ text: "do two things" }] },
    {
      role: "model",
      parts: [
        { text: "First, reading a file." },
        { functionCall: { name: "read_file", args: { absolute_path: "/a.txt" } } },
      ],
    },
    {
      role: "model",
      parts: [
        { text: "Now globbing." },
        { functionCall: { name: "glob_files", args: { pattern: "**/*.ts" } } },
      ],
    },
  ];
  const out = summarizeGeminiChat("/tmp/synth.json", chat, null);

  // 1 collapsed assistant turn
  assert.match(out, /\*\*Assistant turns\*\*: 1/);
  // Both tool calls counted
  assert.match(out, /- Read: 1/);
  assert.match(out, /- Glob: 1/);
});

test("summarizeGeminiChat: functionResponse between model messages splits the turn", () => {
  // When a tool RESULT lands between two model messages (the normal flow),
  // the second model message is a new assistant turn (model-thinks,
  // tool-runs, model-responds). This documents that contract.
  const chat: any[] = [
    { role: "user", parts: [{ text: "do a thing" }] },
    {
      role: "model",
      parts: [
        { text: "Reading." },
        { functionCall: { name: "read_file", args: { absolute_path: "/a.txt" } } },
      ],
    },
    {
      role: "user",
      parts: [{ functionResponse: { name: "read_file", response: { output: "x" } } }],
    },
    { role: "model", parts: [{ text: "Done reading, here's the summary." }] },
  ];
  const out = summarizeGeminiChat("/tmp/synth2.json", chat, null);
  assert.match(out, /\*\*Assistant turns\*\*: 2/);
  // Still only ONE real user message
  assert.match(out, /\*\*User messages\*\*: 1/);
});

test("summarizeGeminiChat: empty chat produces a valid summary with no crash", () => {
  const out = summarizeGeminiChat("/tmp/empty.json", [], null);
  assert.match(out, /^# Gemini Session:/m);
  assert.match(out, /\*\*User messages\*\*: 0/);
  assert.match(out, /\*\*Assistant turns\*\*: 0/);
  assert.match(out, /_\(none\)_/);
  assert.doesNotMatch(out, /## Errors hit/);
});

test("summarizeGeminiChat: file-editing tools populate filesTouched", () => {
  const chat = loadFixture();
  const out = summarizeGeminiChat(FIXTURE, chat, null);
  assert.match(out, /### Files written\/edited/);
  // edit_file with file_path: /proj/README.md
  assert.match(out, /`\/proj\/README\.md`/);
});

test("summarizeGeminiChat: shell commands are captured", () => {
  const chat = loadFixture();
  const out = summarizeGeminiChat(FIXTURE, chat, null);
  assert.match(out, /### Bash commands/);
  assert.match(out, /`npm test`/);
});

test("summarizeGeminiChat: session id strips `checkpoint-` prefix", () => {
  const chat = loadFixture();
  const out = summarizeGeminiChat("/path/to/checkpoint-mytag.json", chat, null);
  assert.match(out, /^# Gemini Session: mytag/m);
  assert.match(out, /\*\*Session ID\*\*: `mytag`/);
});
