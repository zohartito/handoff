# Codex CLI Session Storage — Research Notes

## TL;DR
Feasible and easy-to-medium. The current OpenAI Codex CLI (`@openai/codex`, shipping as the `codex` binary) writes every session as a plain JSONL "rollout" file under `~/.codex/sessions/YYYY/MM/DD/` on all platforms. One event per line, first line is session metadata, rest are turn/tool events. A `session_index.jsonl` in `~/.codex/` gives UUID→title→timestamp. This is the same shape as the Claude Code adapter, so the parser will look almost identical.

## Current product identification
- Package: `@openai/codex` on npm, invoked as `codex` (CLI) or launched from "Codex Desktop"/VS Code extension.
- Confirmed locally: `C:\Users\zohar_4ta16fp\AppData\Roaming\npm\codex.cmd` shims to `node_modules/@openai/codex/bin/codex.js`.
- Versions seen on this machine: `0.118.0` and `0.119.0-alpha.28`. `cli_version` is written into every rollout's `session_meta` line.
- Different product from the retired 2021-2023 Codex API. Current CLI wraps GPT-5-class models.

## Storage locations (confirmed on disk)
- Config root: `$CODEX_HOME` (default `~/.codex`, i.e. `C:\Users\<user>\.codex` on Windows, `~/.codex` on macOS/Linux).
- Sessions: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-timestamp>-<uuid>.jsonl`.
- Index: `$CODEX_HOME/session_index.jsonl` — one JSON per line: `{id, thread_name, updated_at}`.
- Also present (not needed for ingest): `auth.json`, `config.toml`, `logs_2.sqlite` (telemetry logs, not transcripts), `state_5.sqlite`, `memories/`, `rules/`, `skills/`.

## Format — JSONL, one event per line
Every line has `{timestamp, type, payload}`. Observed `type` values in a single large session: `session_meta`, `turn_context`, `event_msg`, `response_item`, `token_count`. The interesting content lives inside `response_item.payload`, which uses nested `type` tags:
- `message` with `role` in `{"user", "assistant", "developer"}` and `content[]` of `input_text` / `output_text`.
- `reasoning` — assistant's thinking blocks.
- `function_call` with `{name, arguments (stringified JSON), call_id}` and matching `function_call_output` with `{call_id, output}`.
- `custom_tool_call` / `custom_tool_call_output`, `web_search_call` / `web_search_end`, `exec_command_end`, `patch_apply_end`.

Example (redacted) first lines:
```
{"timestamp":"2026-04-15T18:48:20.288Z","type":"session_meta","payload":{"id":"019d9278-...","cwd":"C:\\...\\Playground","originator":"Codex Desktop","cli_version":"0.119.0-alpha.28","source":"vscode","model_provider":"openai","base_instructions":{"text":"You are Codex..."}}}
{"timestamp":"...","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}}
{"timestamp":"...","type":"response_item","payload":{"type":"function_call","name":"update_plan","arguments":"{...}","call_id":"call_..."}}
```
Resuming a session appends to the same file; session ID is stable across resumes.

## Parsing approach
- Read-line-by-line, `JSON.parse` each line. Skip malformed lines defensively (rollouts are still being written; the final line may be a partial write).
- Use `session_index.jsonl` to enumerate recent sessions and their human-readable titles without scanning every file.
- Map to handoff's canonical shape: `session_meta` → session header, `response_item.message` → turns, `function_call`/`function_call_output` pairs → tool calls (match on `call_id`).
- Zero native deps — Node's built-in `fs/promises` + `readline` is enough. No SQLite needed.
- Caveat: assistant `message` payloads carry `output_text` chunks that may need concatenation; reasoning blocks can be dropped or preserved depending on handoff's model.

## Stability concerns
- Schema is not versioned in a SemVer sense, but the field names (`session_meta`, `response_item`, `function_call`, `role`, `call_id`) match what DeepWiki, the OpenAI reference docs, and a public discussion thread describe — they've been stable across the `0.10x`–`0.119` range visible in these files.
- OpenAI ships a `codex resume` / `codex exec resume` command that itself parses these files, so a breaking change would break their own UX. Low-medium risk.
- `--json` flag on `codex exec` emits the same event types live, which implies the types are part of the de-facto public surface.

## Recommendation
Build it now. Difficulty is comparable to the Claude Code adapter (also JSONL) and easier than the Cursor SQLite adapter. Two small risks worth coding for: (1) tolerate in-flight writes on the latest rollout, and (2) assert a minimum `cli_version` in `session_meta` so future schema drift surfaces as a clear adapter error rather than silent garbage.

## Sources
- https://developers.openai.com/codex/cli/reference — `codex resume`, `codex exec resume`, `codex fork`, `--last`, `--all`, `--json`.
- https://github.com/openai/codex/discussions/3827 — confirms `rollout-*.jsonl` filename and auto-generated session IDs.
- https://deepwiki.com/openai/codex/4.4-session-resumption-and-forking — describes append-on-resume and the `session_meta` first-line convention.
- https://dev.to/shinshin86/no-resume-in-codex-cli-so-i-built-one-quickly-continue-with-codex-history-list-50be — independent confirmation of `~/.codex/sessions/YYYY/MM/DD/` layout.
- https://github.com/openai/codex/blob/main/docs/config.md — `CODEX_HOME` env var.
- Primary evidence: `C:\Users\zohar_4ta16fp\.codex\session_index.jsonl` and sample rollout files inspected directly.
