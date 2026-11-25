# First-run walkthrough

Observed November 13, 2026 (Pacific), using Node v22.22.3 and the local built
CLI. This is a developer doing the first-run job in a fresh repository, not a
study with a recruited stranger. Reactions below are explicitly **guesses**;
output, exit codes, line counts and elapsed seconds are observations.

The exercise follows the TAC 376 S17 prompt's “walk a mile” principle. The scope
is a repair to shipped `init` guidance. ROADMAP.md's gate on new commands, flags
and other product surface still applies; this change adds none.

## Reproduce and inspect the evidence

```sh
npm ci
npm run build
node scripts/first-run-walkthrough.mjs
npm test
npm run lint
```

The script uses `fs.mkdtempSync`, creates `<tmp-dir>/first-run-sample`, runs
`git init`, writes README.md, and commits it with the subject
`docs: add walkthrough README`. Git identity, configuration and templates are
isolated so local hooks, signing and user settings do not affect setup. It then
runs `node <repo>/bin/handoff.mjs` with that scratch repository as its working
directory for every CLI step. The tables abbreviate this invocation as
`handoff`. The final step extracts the hint from `init` output, substitutes
`claude-code`, and executes its arguments directly, without a shell.

The script prints both tables and the location of
`<tmp-dir>/first-run-walkthrough.json`. The JSON contains stdout, stderr, exit
code, elapsed seconds and primer metrics for each subprocess, plus the actual
environment.md contents. Output stored in the receipt replaces local paths,
username and host name with placeholders. Scratch directories are retained for
inspection; no real project's `.handoff/` is read or changed by the walkthrough.

[first-run-before.json](first-run-before.json) is the sanitized baseline captured
before the production edit, at source revision
`47eca42de994fba0f1d86975f7745fa3270bc9a8`. It was copied from the initial temporary
JSON receipt. Later walkthrough runs read this frozen baseline and measure the
current build afresh; they do not simulate the old behavior or overwrite the
baseline. The after table below is the observed post-repair run. Timings are one
wall-clock sample per command (including process startup), rounded to 0.001 s;
0.000 means below that rounding threshold. These are not human task times or a
performance benchmark. Dependency installation and compilation are prerequisites,
not timed first-run steps.

## Before

| Step | Command | Seconds | What a stranger sees | Friction | Evidence (short excerpt) |
| --- | --- | ---: | --- | --- | --- |
| 1. Create repo | `git init --initial-branch=main --template=` | 0.022 | Empty repo created; exit 0 | none | `Initialized empty Git repository in <tmp-dir>/first-run-sample/.git/` |
| 2. Add project file | write README.md | 0.003 | A title and one sentence; no console output | none | `# first-run-sample` |
| 3. Stage | `git add README.md` | 0.011 | No output; exit 0 | none | stdout and stderr empty |
| 4. Commit | `git -c commit.gpgSign=false commit -m "docs: add walkthrough README"` | 0.017 | One committed file; exit 0 | none | `1 file changed, 3 insertions(+)` |
| 5. Initialize | `handoff init` | 0.053 | Eleven output lines, two manual files to fill, three logging examples and a final command; exit 0. **Guess:** the next-step list requires learning several concepts before seeing value. | low | `source tool: unknown`; `fill in .handoff/task.md`; `handoff prime <target-tool>` |
| 6. Check readiness | `handoff status` | 0.045 | Eight files labeled template; corrections.md and environment.md labeled filled; exit 0. **Guess:** “filled” suggests project context exists. | low | `● environment.md   filled    764b`, yet the file only says `_(refreshed by handoff save)_` under Auto |
| 7. Use documented syntax | `handoff prime --tool claude-code` | 0.045 | 46 lines: preamble, rate-limit protocol, seeded correction and empty environment framing; exit 0. **Guess:** no project facts makes the first payoff unclear. | high | `You are an AI coding agent picking up work that was previously in progress.`; **0 project-fact lines** |
| 8. Use init's syntax | `handoff prime claude-code` | 0.043 | No primer; exit 1. **Guess:** following the tool's own instructions and failing blocks progress. | high | `error: too many arguments for 'prime'. Expected 0 arguments but got 1: claude-code.` |
| 9. Replay printed hint | `handoff prime claude-code` | 0.042 | Same failure from extracting the actual hint; exit 1 | high | Same argument error; confirms the hint and positional probe are the same friction |

The count is **46**, rather than the earlier task prompt's approximate 60. The
baseline environment file is still byte-for-byte the scaffold; `status` calls
it filled because the refresh placeholder survives its template filter.
corrections.md is also unchanged from the scaffold but contains an intentional
seeded rule. Neither label demonstrates that any session facts were captured.

README.md and the printed hint disagree: the command reference documents
`prime --tool <tool>`, while `init` says `prime <target-tool>`. The quick start also
says Claude Code hydrates and logs after initialization, but this scratch run
only creates `.handoff/`; no tool integration was installed or agent session
launched. That documentation expectation is a **low-friction guess**, not a
measured failure of Claude Code integration. Reading and human decision time
were not measured.

## Chosen repair

The highest-priority friction is the printed command that deterministically
fails. Unlike a guess about the value or length of the primer, this is an
observable dead end in the tool's own next-step path.

Only one production line changes, in `src/commands/init.ts`:

```diff
-  console.log("  4. when handing off: handoff prime <target-tool>");
+  console.log("  4. when handing off: handoff prime --tool <target-tool>");
```

The added test in `tests/init.test.ts` captures `init` output, extracts the
printed command, substitutes `claude-code`, runs it through the compiled CLI,
and asserts that it emits a Claude Code primer. It failed before the repair
with the observed argument error. It does not merely compare the hint to a
second hardcoded string.

## After

| Step | Command | Seconds | What a stranger sees | Friction | Evidence (short excerpt) |
| --- | --- | ---: | --- | --- | --- |
| 1. Create repo | `git init --initial-branch=main --template=` | 0.008 | Empty repo created; exit 0 | none | `Initialized empty Git repository in <tmp-dir>/first-run-sample/.git/` |
| 2. Add project file | write README.md | 0.000 | The same README; no console output | none | `# first-run-sample` |
| 3. Stage | `git add README.md` | 0.007 | No output; exit 0 | none | stdout and stderr empty |
| 4. Commit | `git -c commit.gpgSign=false commit -m "docs: add walkthrough README"` | 0.015 | One committed file; exit 0 | none | `1 file changed, 3 insertions(+)` |
| 5. Initialize | `handoff init` | 0.047 | Same manual steps, corrected final command; exit 0. **Guess:** learning the file/logging model still takes effort. | low | `handoff prime --tool <target-tool>` |
| 6. Check readiness | `handoff status` | 0.044 | Same eight template/two filled labels; exit 0. **Guess:** the misleading environment label still implies readiness. | low | `● environment.md   filled    764b` |
| 7. Use documented syntax | `handoff prime --tool claude-code` | 0.046 | Same 46-line primer, still no project facts; exit 0. **Guess:** first payoff remains unclear. | high | **0 project-fact lines** |
| 8. Probe old syntax | `handoff prime claude-code` | 0.040 | Still rejected; exit 1. This is now a diagnostic probe, not the printed next step. | high | `Expected 0 arguments but got 1: claude-code.` |
| 9. Replay printed hint | `handoff prime --tool claude-code` | 0.045 | Claude Code primer appears; exit 0 | none for execution | `# HANDOFF PRIMER`; `You are Claude Code.` |

The old syntax remains unsupported. The repair directs the user to existing
working syntax without expanding the parser or changing primer content.

## Metrics and verification

A project-fact line matches the scratch repo name (`first-run-sample`), its
known commit subject, README.md, or an observed git-status entry for `.handoff/`.
Each matching line counts once. Generic instructions mentioning `.handoff/`,
task.md or a hypothetical CLAUDE.md do not count as observed project facts.
“Boilerplate” below is the remaining nonblank lines; blanks are reported
separately. This is a narrow deterministic check, not a judgment of user value.

| Metric | Before | After |
| --- | ---: | ---: |
| Printed hint exit code (chosen acceptance metric) | 1 | **0** |
| Printed hint emits a Claude Code primer | no | **yes** |
| Project-fact lines in documented primer | 0 | 0 |
| Boilerplate / blank / total lines | 30 / 16 / 46 | 30 / 16 / 46 |
| Positional probe exit code | 1 | 1 |

Actual walkthrough summary:

```text
project-fact lines in primer: 0 → 0
printed hint exit code: 1 → 0
```

`npm run build`, `npm test`, `npm run lint` and the walkthrough all exited 0.
The walkthrough intentionally records the unsupported positional probe's exit 1;
it requires the real printed hint to succeed when comparing with the baseline.
Actual full-suite result (351 existing tests plus the regression):

```text
1..352
# tests 352
# suites 0
# pass 352
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3169.244208
```

## Next two frictions

1. **No project context on first prime.** Addressed: `init` now calls the existing
   `save()` after writing templates/meta, so git and runtime facts reach
   environment.md immediately (the refusal on an existing `.handoff/` is unchanged).
   Measured with this walkthrough on November 25, 2026: project-fact lines in the
   documented primer went **0 → 3** (cwd, `?? .handoff/` status, commit subject)
   and the printed hint still exits 0. The walkthrough now exits 1 if the first
   prime lacks the cwd, `main` branch, commit subject or `.handoff/` status, or
   has fewer than three fact lines. The snapshot does not invent task intent.
2. **Template environment reported as filled.** Make `status` distinguish a
   refresh placeholder and seeded guidance from captured project/session facts.
   It already identifies eight untouched files correctly, so adding another
   file-listing command would not address this problem.
