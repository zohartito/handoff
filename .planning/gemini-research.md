# Gemini CLI — Session Storage Research

## 1. TL;DR

Feasible, **medium difficulty**. Gemini CLI stores chat history on disk as JSON files under `~/.gemini/tmp/<project_hash>/`, using the same `{role, parts[]}` shape as the Gemini API — trivially parseable with stdlib JSON. Caveats: (a) files only appear after `/chat save <tag>` or when checkpointing is triggered by a file-writing tool; default chats are ephemeral until then, and (b) the project is actively migrating from JSON to JSONL (issue #15292), so a parser must handle both.

## 2. Product identification

- **Repo**: `google-gemini/gemini-cli` (open-source, Apache 2.0).
- **Launch command**: `gemini` (interactive TUI) or `gemini -p "..."` (non-interactive).
- **Install**: npm — `npm install -g @google/gemini-cli`. On Windows, binary lands at `%APPDATA%\npm\gemini.cmd`. Confirmed installed on this machine: `C:\Users\zohar_4ta16fp\AppData\Roaming\npm\gemini.cmd`.
- This is distinct from "Gemini Code Assist" (IDE plugin) and the Gemini web app.

## 3. Storage locations

Base dir: `~/.gemini/` (Windows: `C:\Users\<user>\.gemini\`).

Observed layout on this machine:

```
.gemini/
  settings.json          # auth config
  state.json             # UI state
  projects.json          # maps absolute project path -> project_hash
  oauth_creds.json       # tokens
  installation_id        # anon telemetry id
  history/<project_hash>/  # shadow git repo for file-snapshot checkpoints
  tmp/<project_hash>/
    .project_root        # absolute path of the cwd that owns this dir
    logs.json            # input log — every user prompt
    chats/               # saved chat checkpoints live here
    checkpoints/         # auto-checkpoints (conversation + pending tool call)
```

`projects.json` from this machine:
```json
{"projects": {"c:\\users\\zohar_4ta16fp": "zohar-4ta16fp"}}
```

Note: the hash is a **slugified basename**, not a content hash — at least for top-level home dirs. For nested projects it's a sha256-style hash (per docs); the mapping table in `projects.json` is authoritative.

Same paths on macOS/Linux: `~/.gemini/tmp/<project_hash>/...` — no platform divergence.

## 4. Format

**Saved chats** (`/chat save mytag`) → `chats/checkpoint-mytag.json`:

```json
[
  {"role": "user",  "parts": [{"text": "refactor foo.py"}]},
  {"role": "model", "parts": [{"functionCall": {"name": "read_file", "args": {"path": "foo.py"}}}]},
  {"role": "user",  "parts": [{"functionResponse": {"name": "read_file", "response": {...}}}]},
  {"role": "model", "parts": [{"text": "Here's the refactor..."}]}
]
```

Array of message objects; each has `role` ∈ {`user`, `model`} and a `parts[]` whose entries are one of `{text}`, `{functionCall: {name, args}}`, `{functionResponse: {name, response}}`. This is the vanilla Gemini API `Content` shape.

**Auto-checkpoints** (when a write-file tool is about to run) → `checkpoints/<timestamp>-<filename>-<toolname>.json`, e.g. `2025-06-22T10-00-00_000Z-my-file.txt-write_file`. Contains conversation history + the pending tool call; paired with a git snapshot under `~/.gemini/history/<project_hash>/`.

**Auto-recorded sessions** (newer, issue #15292) add `SessionInfo` metadata: `sessionId`, `startTime`, `lastUpdated`, `messageCount`, `displayName`, plus per-message `tokens`, `totalLinesAdded/Removed`. Migrating to JSONL with record types `session_metadata`, `user`, `gemini`, `message_update`.

**Input log** `logs.json`: flat array of user prompts (empty `[]` on this machine — nothing typed yet).

## 5. Parsing approach

- Read `~/.gemini/projects.json` → map user cwd → `<project_hash>`.
- Glob `~/.gemini/tmp/<hash>/chats/checkpoint-*.json` and `checkpoints/*.json`.
- For future-proofing, also glob `*.jsonl` and dispatch per-line by `type`.
- `JSON.parse` (Node) or `json.loads` (Python) — no binary formats, no SQLite.
- Tool calls map cleanly to handoff's existing shape (claude-code's `tool_use` ≈ `functionCall`; `tool_result` ≈ `functionResponse`).
- `--resume` flag exists (`gemini --resume` or `-r`) but just picks the latest timestamp — no need to replicate.

## 6. Stability concerns

- Format is **documented** (checkpointing docs page) and stable enough that two official docs sites describe it.
- **Active migration to JSONL** (#15292) is the main churn risk — land support for both or gate behind a version sniff.
- Default sessions are **not persisted** unless the user runs `/chat save` or auto-checkpointing fires. Many casual users will have empty `chats/`. Handoff should surface this clearly ("no saved Gemini sessions found — run `/chat save <tag>` in Gemini CLI first").
- Fast release cadence (repo had 20k+ stars within months); treat schema as a moving target but the `role`/`parts` core is locked by the Gemini API contract.

## 7. Recommendation

**Build now.** The format is simple JSON, documented, and maps cleanly to the existing handoff schema. Ship v1 reading the `.json` array format (covers today's saved chats + auto-checkpoints). Add `.jsonl` support as a follow-up once #15292 lands in a release. Biggest UX risk isn't parsing — it's that users won't have any files to ingest unless they've explicitly saved. Handle that gracefully.

## 8. Sources

- https://github.com/google-gemini/gemini-cli
- https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html
- https://github.com/google-gemini/gemini-cli/discussions/4974 (filename `checkpoint-<name>.json`, role/parts confirmation)
- https://github.com/google-gemini/gemini-cli/issues/15292 (JSON → JSONL migration, record schema)
- https://github.com/google-gemini/gemini-cli/discussions/1538 (resume behavior)
- https://deepwiki.com/google-gemini/gemini-cli/3.9-session-management (SessionInfo fields)
- https://ai.google.dev/gemini-api/docs/function-calling (functionCall/functionResponse shape)
- Local inspection: `C:\Users\zohar_4ta16fp\.gemini\` (projects.json, tmp layout)
