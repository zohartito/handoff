# Session dump — 2026-04-18

The user asked me to refactor the `capture.ts` command so that it can
be invoked by the outgoing AI at session close, without a human needing
to run individual `handoff decide` / `handoff correct` calls one by one.

TASK: implement `handoff capture` end-of-session command

I started by reading `src/cli.ts` to understand the command registration
pattern, then looked at `decide.ts` and `correct.ts` for the idiomatic
single-file command shape. A few things came up while working:

- The user pointed out that I was about to overwrite the existing
  transcript file on a second run, which is a data-loss bug.
CORRECTION: do not overwrite transcript.md on subsequent runs; append with a session separator instead
- After looking at the lock utility I realized `withFileLock` already
  handles the race between two concurrent AIs calling capture, so we
  don't need a new mutex.

DECISION: use `.handoff/transcript.md` (markdown) rather than extending the existing JSONL transcript path
DECISION: marker extraction is line-oriented and case-insensitive so it tolerates "decision:" vs "DECISION:"

Some prose in the middle that contains the word "decision" but is NOT
a marker — the extractor must not pick this up because there's no
colon directly after the word.

TODO: add a `--dry-run` flag in a follow-up so the AI can preview extraction without writing
TODO: document the marker format in README under "end-of-session ritual"

Closing thought: this is the final turn of the session, so the next
agent will see the populated `.handoff/` files on startup.
