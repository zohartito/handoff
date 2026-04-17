import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeSession,
  renderMarkdown,
  humanDuration,
  cwdMatchesProject,
  normalizeForCompare,
  type RenderCtx,
} from "../src/commands/ingest.js";

const here = dirname(fileURLToPath(import.meta.url));
// `here` at runtime is dist/tests/ — fixtures sit next to the source at tests/fixtures/
const FIXTURE = resolve(here, "../../tests/fixtures/claude-code-session.jsonl");

test("summarizeSession parses JSONL and renders all expected sections", async () => {
  const out = await summarizeSession(FIXTURE);

  // H1 heading
  assert.match(out, /^# Claude Code Session: abc12345/m);
  // Metadata line
  assert.match(out, /\*\*Session ID\*\*: `abc12345-6789-0000-1111-222233334444`/);
  assert.match(out, /\*\*Project cwd\*\*: `C:\\Users\\test\\proj`/);

  // Section headers in order
  const userIdx = out.indexOf("## User messages (chronological)");
  const toolIdx = out.indexOf("## Tool activity");
  const finalIdx = out.indexOf("## Assistant's final messages");
  assert.ok(userIdx > 0, "user messages section present");
  assert.ok(toolIdx > userIdx, "tool activity section after user messages");
  assert.ok(finalIdx > toolIdx, "final messages section after tool activity");

  // Tool-activity subsections
  assert.match(out, /### Files written\/edited/);
  assert.match(out, /### Bash commands \(deduped, first 30\)/);

  // User messages body: both string-content user msgs appear; tool_result one does NOT
  assert.match(out, /Please fix the typo in README\.md/);
  assert.match(out, /Try again with the right permissions/);

  // Tool counts
  assert.match(out, /- Bash: 1/);
  assert.match(out, /- Edit: 1/);

  // Files touched — Edit's file_path
  assert.match(out, /`C:\\Users\\test\\proj\\README\.md`/);

  // Bash command captured
  assert.match(out, /`ls -la`/);

  // Error from tool_result with is_error:true
  assert.match(out, /## Errors hit/);
  assert.match(out, /\*\*Edit\*\*:.*EACCES/);

  // Duration: 10:00:00 → 10:30:00 = 30m
  assert.match(out, /\*\*Duration\*\*: 30m/);

  // Final assistant message captured
  assert.match(out, /Done — README\.md updated successfully\./);
});

test("summarizeSession skips malformed JSONL lines without crashing", async () => {
  // Fixture contains a `bad-line-that-should-be-skipped` literal line
  const out = await summarizeSession(FIXTURE);
  assert.ok(out.length > 0);
  // If we got here without throwing, the malformed line was silently skipped.
  // Also sanity-check: user/assistant counts weren't corrupted by the bad line.
  assert.match(out, /\*\*User messages\*\*: 2/);
  assert.match(out, /\*\*Assistant turns\*\*: 3/);
});

test("cwdMatchesProject: exact and descendant paths match, unrelated paths do not", () => {
  const proj = "C:\\Users\\zohar_4ta16fp\\handoff";
  // exact match (same case)
  assert.equal(cwdMatchesProject("C:\\Users\\zohar_4ta16fp\\handoff", proj), true);
  // case-insensitive (Windows paths)
  assert.equal(cwdMatchesProject("c:\\users\\zohar_4ta16fp\\handoff", proj, "win32"), true);
  // trailing slash tolerated
  assert.equal(cwdMatchesProject("C:\\Users\\zohar_4ta16fp\\handoff\\", proj), true);
  // descendant
  assert.equal(cwdMatchesProject("C:\\Users\\zohar_4ta16fp\\handoff\\src", proj), true);
  // forward-slash mix
  assert.equal(cwdMatchesProject("C:/Users/zohar_4ta16fp/handoff", proj), true);
  // parent is NOT a match — this is the bug Codex found
  assert.equal(cwdMatchesProject("C:\\Users\\zohar_4ta16fp", proj), false);
  // sibling is not a match
  assert.equal(cwdMatchesProject("C:\\Users\\zohar_4ta16fp\\other", proj), false);
  // prefix-only (no separator) is not a match: /foo/handoff-extra should NOT match /foo/handoff
  assert.equal(cwdMatchesProject("C:\\Users\\zohar_4ta16fp\\handoff-extra", proj), false);
  // null cwd never matches
  assert.equal(cwdMatchesProject(null, proj), false);
});

test("cwdMatchesProject: platform-conditional case sensitivity", () => {
  // Linux: case-sensitive — /Users/Foo and /Users/foo are different dirs
  assert.equal(cwdMatchesProject("/Users/Foo/proj", "/Users/Foo/proj", "linux"), true);
  assert.equal(cwdMatchesProject("/Users/foo/proj", "/Users/Foo/proj", "linux"), false);
  assert.equal(cwdMatchesProject("/users/Foo/proj", "/Users/Foo/proj", "linux"), false);
  // Descendants still work with exact case
  assert.equal(cwdMatchesProject("/Users/Foo/proj/src", "/Users/Foo/proj", "linux"), true);

  // macOS: default FS is case-insensitive (though case-preserving)
  assert.equal(cwdMatchesProject("/Users/Foo/proj", "/Users/Foo/proj", "darwin"), true);
  assert.equal(cwdMatchesProject("/users/foo/proj", "/Users/Foo/proj", "darwin"), true);
  assert.equal(cwdMatchesProject("/Users/FOO/proj/src", "/users/foo/proj", "darwin"), true);

  // Windows: case-insensitive — C:\Foo and c:\foo are the same
  assert.equal(cwdMatchesProject("C:\\Foo\\proj", "c:\\foo\\proj", "win32"), true);
});

test("normalizeForCompare: lowercases only on win32/darwin", () => {
  // win32: full lowercase
  assert.equal(normalizeForCompare("C:\\Users\\Foo", "win32"), "c:/users/foo");
  // darwin: full lowercase
  assert.equal(normalizeForCompare("/Users/Foo", "darwin"), "/users/foo");
  // linux: preserves case
  assert.equal(normalizeForCompare("/Users/Foo", "linux"), "/Users/Foo");
  // trailing separator stripped
  assert.equal(normalizeForCompare("/Users/Foo/", "linux"), "/Users/Foo");
  assert.equal(normalizeForCompare("/Users/Foo\\", "linux"), "/Users/Foo");
  // backslashes converted to forward slashes
  assert.equal(normalizeForCompare("a\\b\\c", "linux"), "a/b/c");
});

test("humanDuration formats minutes and hours correctly", () => {
  assert.equal(humanDuration("2026-04-01T10:00:00Z", "2026-04-01T10:30:00Z"), "30m");
  assert.equal(humanDuration("2026-04-01T10:00:00Z", "2026-04-01T12:15:00Z"), "2h15m");
  assert.equal(humanDuration("2026-04-01T10:00:00Z", "2026-04-01T11:00:00Z"), "1h0m");
  // Negative / invalid → "?"
  assert.equal(humanDuration("2026-04-01T12:00:00Z", "2026-04-01T10:00:00Z"), "?");
  assert.equal(humanDuration(null, "2026-04-01T10:00:00Z"), "?");
  assert.equal(humanDuration("2026-04-01T10:00:00Z", null), "?");
});

test("renderMarkdown: empty session produces empty-state placeholders", () => {
  const ctx: RenderCtx = {
    sourceLabel: "Claude Code",
    sessionId: "deadbeef-1234",
    file: "/tmp/empty.jsonl",
    cwd: null,
    firstTs: null,
    lastTs: null,
    userMsgs: [],
    assistantTurns: [],
    errors: [],
    toolCounts: {},
    filesTouched: new Set(),
    bashCommands: [],
  };
  const md = renderMarkdown(ctx);
  assert.match(md, /^# Claude Code Session: deadbeef/m);
  assert.match(md, /## User messages \(chronological\)\s*\n\s*\n_\(none\)_/);
  assert.match(md, /## Tool activity\s*\n\s*\n_\(no tool calls\)_/);
  assert.match(md, /## Assistant's final messages\s*\n\s*\n_\(none\)_/);
  // No subsections for files/bash/errors when none
  assert.doesNotMatch(md, /### Files written\/edited/);
  assert.doesNotMatch(md, /### Bash commands/);
  assert.doesNotMatch(md, /## Errors hit/);
});

test("renderMarkdown: session with only errors still renders error section", () => {
  const ctx: RenderCtx = {
    sourceLabel: "Claude Code",
    sessionId: "errs0000",
    file: "/tmp/errs.jsonl",
    cwd: "/tmp",
    firstTs: "2026-04-01T10:00:00Z",
    lastTs: "2026-04-01T10:00:05Z",
    userMsgs: [],
    assistantTurns: [],
    errors: [
      { ts: "2026-04-01T10:00:01Z", tool: "Bash", error: "command not found: xyz" },
      { ts: "2026-04-01T10:00:02Z", tool: "Edit", error: "file not found" },
    ],
    toolCounts: {},
    filesTouched: new Set(),
    bashCommands: [],
  };
  const md = renderMarkdown(ctx);
  assert.match(md, /## Errors hit/);
  assert.match(md, /\*\*Bash\*\*: command not found: xyz/);
  assert.match(md, /\*\*Edit\*\*: file not found/);
});

test("renderMarkdown: bash commands are deduped", () => {
  const ctx: RenderCtx = {
    sourceLabel: "Claude Code",
    sessionId: "dedup000",
    file: "/tmp/x.jsonl",
    cwd: "/tmp",
    firstTs: "2026-04-01T10:00:00Z",
    lastTs: "2026-04-01T10:00:05Z",
    userMsgs: [],
    assistantTurns: [],
    errors: [],
    toolCounts: { Bash: 3 },
    filesTouched: new Set(),
    bashCommands: ["ls -la", "ls -la", "  ls -la  ", "git status"],
  };
  const md = renderMarkdown(ctx);
  // Count occurrences of each line
  const lsLines = md.split("\n").filter((l) => l.trim() === "- `ls -la`");
  const gitLines = md.split("\n").filter((l) => l.trim() === "- `git status`");
  assert.equal(lsLines.length, 1, "ls -la appears only once after dedup");
  assert.equal(gitLines.length, 1, "git status appears once");
});

test("summarizeSession: empty file returns a well-formed empty summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-empty-"));
  const file = join(dir, "empty.jsonl");
  writeFileSync(file, "", "utf8");
  try {
    const out = await summarizeSession(file);
    assert.match(out, /^# Claude Code Session:/m);
    assert.match(out, /\*\*User messages\*\*: 0/);
    assert.match(out, /\*\*Assistant turns\*\*: 0/);
    assert.match(out, /_\(none\)_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
