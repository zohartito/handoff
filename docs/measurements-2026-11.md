# What survives a handoff?

Measured 2026-11-17 with the CLI built from main `3d7e335`, Node 22.22.3, against private local snapshots, including handoff's uncommitted attempts. The CLI revision identifies the executable. Input hashes and the transcript selection are recorded in the local measurement manifest. In a controlled replay of a 302A session spanning six compactions, neither of two earlier side requests appeared verbatim in the receiving primer.

## Project files

Physical lines per standard file at the root of `.handoff/`. A dash means absent and zero means an existing empty file. The two one-line JSONL files in handoff contain only a newline. TAC 376 also has two dated sync folders outside this inventory.

| File | handoff | TAC 376 | 302A |
|---|---:|---:|---:|
| HANDOFF.md | 31 | — | 197 |
| task.md | 51 | — | 339 |
| progress.md | 46 | — | 6,222 |
| open-loops.md | 21 | — | 2,229 |
| attempts.md | 175 | 962 | 5,770 |
| corrections.md | 32 | — | 1,358 |
| decisions.md | 78 | — | 1,920 |
| environment.md | 66 | 0 | 0 |
| codebase-map.md | 19 | — | 209 |
| identity.md | 20 | — | 39 |
| references.md | 13 | — | 207 |
| files.json | 4 | — | 4 |
| meta.json | 8 | — | 8 |
| .capture-state.json | 12 | 329 | 499 |
| tool-history.jsonl | 1 | — | — |
| transcript.jsonl | 1 | — | — |

| Current CLI result | handoff | TAC 376 | 302A |
|---|---:|---:|---:|
| Files marked filled by `status` (of 10) | 7 | 1 | 9 |
| Attempt events / distinct bodies, `compact attempts --dry-run` | 18 / 16 | 24 / 14 | 158 / 91 |
| `prime --compact` stdout lines / exit code | 36 / 1 | 47 / 0 | 31 / 1 |
| Constraints the primer reported dropping | 2 | 0 | 36 |

All three compact primers already fit in 60 lines. The two exit codes of 1 report lost constraints. TAC 376 exits successfully even though it lacks a goal and open loops. Its existing 24 events also already meet the proposed limit of 30.

## Which attempts are worth keeping?

I reviewed every event in the two requested project logs and the three attempts produced by the selected transcript replay. I counted one entry per distinct, project-relevant dead end supported by a successful change of approach on the same task, an independent recurrence, or a user correction. For auto-captured failures I matched the command to its tool call and checked subsequent tool results. Duplicate log writes, successful checks and incidental shell probes were excluded. A generic “later succeeded” field alone was insufficient.

| Reviewed source | Keep / stored | Evidence and hand labels (1-based file order) |
|---|---:|---|
| handoff | 5 / 18 (27.8%) | 1–5 document failures and concrete fixes. Eleven rows are successful checks. Two identical rate-limit notices arrived 26 ms apart and establish neither independent recurrence nor a successful switch. |
| TAC 376 | 10 / 24 (41.7%) | Keep 2, 3, 5, 9, 11, 13, 16, 18, 20, 22. Nine have a successful alternative for the same operation. Row 20 represents the recurring rate limit. Exclude ten duplicate bodies, two probes, a second variant of one failed approach, and a different project's operation. |
| 302A single-transcript replay | 2 / 3 (66.7%) | Rows 1 and 3 have confirmed alternatives for the same output. Row 2 printed comparison results before returning nonzero. Repeated transcript records have the same tool-use ID. |

TAC 376's 962 lines contain 18 guard-blocked commands, two failed probes and four rate-limit notices. Of the 20 tagged auto, nine merit a distinct entry (45%). Filtering shell probes alone would leave most of the volume.

## Transcript replay

The 302A JSONL last modified November 16 contains 224.4 MiB, 11,037 lines and six compact boundaries. One `hook pre-compact` over the complete file, starting with an empty `.handoff/`, produced attempts.md (3 records, 62 lines), corrections.md (2 records, 17 lines) and .capture-state.json (16 lines). It wrote no open loops or current-state files. A subsequent `hook session-start` with source `compact` contained zero of two manually selected earlier side requests verbatim. The two spot checks do not estimate recall. This isolates one hook invocation. Historical Stop timing and the agent's original answers were outside this replay.

## Reproduce locally

From the measurement checkout, set `session` to the selected local JSONL and `ask_a` and `ask_b` to the two user-message line numbers from the private manifest. The driver prints counts, input hashes and exit codes, uses temporary copies, and removes them on exit. These inputs have no evidence references outside the copied files. The keep fractions are manual judgments. Use the numbered headings and label key above to recount them against the same input.

```sh
npm ci && npm run build
course="$HOME/projects/Fall 2026"
node scripts/measure-continuity.mjs "$HOME/projects/handoff"
node scripts/measure-continuity.mjs "$course/TAC 376"
node scripts/measure-continuity.mjs "$course/302A" "$session" "$ask_a" "$ask_b"
rg --no-filename '^## [0-9]{4}-.*Z$' "$course/TAC 376/.handoff/attempts.md" | nl -ba
shasum -a 256 "$session"
```

Direct `handoff ingest --from claude-code --project "$course/302A" --session "$(basename "$session" .jsonl)" --out "$TMPDIR/302A-ingest.md"` exited 1 with “session not found”. Its directory encoder preserves spaces in the project path. Passing the transcript path to the hook exercised capture successfully.
