// Generates `cursor-state.vscdb` — a minimal SQLite fixture mimicking Cursor's
// global state DB layout, with one composer containing 2 user bubbles and
// 2 assistant bubbles (one with tool use, one plain text).
//
// Regenerate with:
//   node tests/fixtures/build-cursor-fixture.mjs
//
// Requires Node 22+ (node:sqlite).
import { DatabaseSync } from "node:sqlite";
import { unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "cursor-state.vscdb");
if (existsSync(out)) unlinkSync(out);

const db = new DatabaseSync(out);
db.exec(`
  CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
  CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);
`);

const composerId = "cursor01-aaaa-bbbb-cccc-000000000001";

// Bubble IDs in order: user, assistant+tool, user, assistant (plain text)
const bubbles = [
  {
    id: "b-001",
    type: 1, // user
    text: "Please read src/index.ts and show me the main function",
    createdAt: "2026-04-01T12:00:00.000Z",
  },
  {
    id: "b-002",
    type: 2, // assistant
    text: "I'll read the file to find the main function.",
    createdAt: "2026-04-01T12:00:05.000Z",
    toolFormerData: {
      name: "read_file_v2",
      status: "success",
      params: JSON.stringify({ relativeWorkspacePath: "src/index.ts" }),
      result: JSON.stringify({ contents: "export function main() {}" }),
    },
  },
  {
    id: "b-003",
    type: 1, // user
    text: "Now run the tests and update the README",
    createdAt: "2026-04-01T12:05:00.000Z",
  },
  {
    id: "b-004",
    type: 2, // assistant
    text: "Running the tests now.",
    createdAt: "2026-04-01T12:05:10.000Z",
    toolFormerData: {
      name: "run_terminal_command_v2",
      status: "success",
      params: JSON.stringify({ command: "npm test" }),
      result: JSON.stringify({ exitCode: 0, output: "all tests passed" }),
    },
  },
  {
    id: "b-005",
    type: 2, // assistant
    text: "Editing the README now.",
    createdAt: "2026-04-01T12:05:15.000Z",
    toolFormerData: {
      name: "edit_file_v2",
      status: "success",
      params: JSON.stringify({ relativeWorkspacePath: "README.md" }),
      result: JSON.stringify({ success: true }),
    },
  },
  {
    id: "b-006",
    type: 2, // assistant (plain text, no tool)
    text: "Tests passed and README updated.",
    createdAt: "2026-04-01T12:10:00.000Z",
  },
];

const composerRecord = {
  _v: 1,
  composerId,
  createdAt: Date.parse("2026-04-01T12:00:00.000Z"),
  status: "completed",
  unifiedMode: "chat",
  modelConfig: { modelName: "claude-opus-4", maxMode: false },
  fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.id, type: b.type })),
};

const encoder = new TextEncoder();

function putKV(key, value) {
  db.prepare(`INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(
    key,
    encoder.encode(JSON.stringify(value)),
  );
}

putKV(`composerData:${composerId}`, composerRecord);
for (const b of bubbles) {
  putKV(`bubbleId:${composerId}:${b.id}`, b);
}

// Also stash an error-bubble composer for the error-path test
const errComposerId = "cursor02-aaaa-bbbb-cccc-000000000002";
const errBubbles = [
  {
    id: "eb-001",
    type: 1,
    text: "delete the file foo.txt",
    createdAt: "2026-04-01T13:00:00.000Z",
  },
  {
    id: "eb-002",
    type: 2,
    text: "",
    createdAt: "2026-04-01T13:00:05.000Z",
    toolFormerData: {
      name: "delete_file",
      status: "error",
      params: JSON.stringify({ path: "foo.txt" }),
      result: JSON.stringify({ error: "file not found" }),
    },
  },
];
const errComposer = {
  _v: 1,
  composerId: errComposerId,
  createdAt: Date.parse("2026-04-01T13:00:00.000Z"),
  status: "completed",
  fullConversationHeadersOnly: errBubbles.map((b) => ({ bubbleId: b.id, type: b.type })),
};
putKV(`composerData:${errComposerId}`, errComposer);
for (const b of errBubbles) putKV(`bubbleId:${errComposerId}:${b.id}`, b);

db.close();
console.log(`wrote ${out}`);
