# handoff

Preserve user requests across compactions and tool changes. Linear holds the work list. This file holds current state.

## In progress

ZOH-105 adds offline verbatim ask capture in Claude Code. The prototype is on `codex/capture-verbatim-asks`.
On a reserved session it found 6 of 14 side requests in 40 turns and flagged 2 other turns. Precision was 75.0% and recall was 42.9%. The targets are 80% and 90%.
Next, choose whether to benchmark a desktop Ollama model or review heuristic suggestions manually. [ZOH-163](https://linear.app/zohartito/issue/ZOH-163)

## Decisions

The root STATE.md is canonical. ZOH-107 will preserve existing task and progress text before replacing the two legacy files with pointers.
ZOH-110 will score the fresh-session eval using a dated Linear export and an answer key for the same date.
ZOH-104 measured baseline continuity. [Measurement PR](https://github.com/zohartito/handoff/pull/44)

## Verify

Run `npm run build`, `npm run lint`, and `npm test` on the prototype branch.
The real-prompt test automatically reads the private labelled fixture on the evaluation Mac. Set `HANDOFF_ASK_FIXTURE` for another path. Public CI skips that test.
