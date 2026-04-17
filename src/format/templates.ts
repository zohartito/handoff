export const HEADER_COMMENT = `<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works. When an agent picks up this project, it should read every
file in this directory before taking action.
-->`;

export const templates: Record<string, string> = {
  "HANDOFF.md": `# HANDOFF

${HEADER_COMMENT}

This is a portable snapshot of an AI-assisted work session. Read the files
below **in order** before taking any action.

1. \`task.md\` — the goal, constraints, success criteria
2. \`progress.md\` — what's done / in-flight / blocked / next
3. \`decisions.md\` — key choices already made and why
4. \`attempts.md\` — approaches that failed and what finally worked
5. \`corrections.md\` — times the prior agent got it wrong and what the user meant
6. \`identity.md\` — the user's tone, style, and preferences
7. \`environment.md\` — OS, shell, versions, git state
8. \`codebase-map.md\` — key files, conventions, architecture
9. \`open-loops.md\` — unfinished threads and questions blocked on the user
10. \`references.md\` — URLs and docs that were consulted

Raw logs (read only when you need detail):
- \`ingested-context.md\` — imported summary from a past tool session (created by \`handoff ingest\`)
- \`tool-history.jsonl\` — every tool call the prior agent made
- \`transcript.jsonl\` — raw conversation turns
- \`files.json\` — file manifest with hashes

> When you finish a chunk of work, append to the relevant files using the
> \`handoff attempt|decide|correct|save\` commands so the next agent benefits.
`,

  "task.md": `# Task

${HEADER_COMMENT}

<!--
The north star. Every agent should read this first.
- What are we trying to accomplish?
- Why? (underlying user goal, not surface ask)
- What does "done" look like? (acceptance criteria)
- What are the hard constraints? (must use X, cannot use Y)
-->

## Goal

<!-- one-sentence version of what we're building -->

## Why

<!-- the underlying user problem this solves -->

## Done looks like

<!-- concrete, testable acceptance criteria -->

## Constraints

<!-- must-haves, must-not-haves, non-negotiables -->
`,

  "progress.md": `# Progress

${HEADER_COMMENT}

<!--
What's done, what's in flight, what's blocked, what's next.
Update as state changes. Delete stale items.
-->

## Done

## In flight

## Blocked

## Next
`,

  "decisions.md": `# Decisions

${HEADER_COMMENT}

<!--
Key choices that have been made, with reasoning. New agents: read this
before proposing a different approach — if a decision is here, it's been
argued once already.

Use \`handoff decide "chose X" --because "reason"\` to append.
-->
`,

  "attempts.md": `# Attempts

${HEADER_COMMENT}

<!--
Failed approaches with full error traces. This is the file that prevents
the next agent from repeating mistakes.

Each entry:
- what was tried
- full error output (verbatim — don't summarize it away)
- what the fix was, or how it was abandoned
- optional: agent-written summary

Use \`handoff attempt "tried X" --error "trace" --fix "what worked"\` to append.
-->
`,

  "corrections.md": `# Corrections

${HEADER_COMMENT}

<!--
Times the prior agent got it wrong, and what the user actually meant.
This is the user's implicit rubric — their real preferences as revealed
by feedback, not as stated in prefs files.

Use \`handoff correct "what I did" --user-said "their feedback"\` to append.
-->

## don't re-explain the project context to the user

- The user is the same across sessions — they do NOT want to re-answer "what is this project about?" or "what are you trying to build?"
- Read \`.handoff/task.md\`, \`.handoff/progress.md\`, and \`.handoff/HANDOFF.md\` before asking context questions.
- If genuinely ambiguous, ask one targeted question — not a reset question.

_— seeded by \`handoff init\`; replace/augment with project-specific corrections as they arise._
`,

  "identity.md": `# Identity

${HEADER_COMMENT}

<!--
The user's tone, style, and communication preferences — scoped to THIS
project. Different from a global CLAUDE.md: this is project-specific
calibration.

- preferred tone (terse? verbose? casual? formal?)
- naming conventions they prefer
- level of autonomy they want (ask a lot vs. decide and ship)
- code style preferences observed
- pet peeves (things that have visibly annoyed them)
-->
`,

  "environment.md": `# Environment

${HEADER_COMMENT}

<!--
The runtime context. \`handoff save\` auto-refreshes the machine-readable
bits; human notes go below.

Auto-refreshed (do not hand-edit):
- OS, shell, language runtimes
- cwd
- git branch + status + diff summary
- installed deps (if detectable)

Human notes:
- local services running (dev servers, DBs, tunnels)
- environment-specific gotchas
- credentials/tokens needed (by name only — never paste values here)
-->

## Auto

_(refreshed by \`handoff save\`)_

## Human notes
`,

  "codebase-map.md": `# Codebase Map

${HEADER_COMMENT}

<!--
Where things live. What conventions are used. The architectural cheat-sheet
a new agent needs to avoid wandering.

- entry points
- key files / modules + one-line purpose each
- naming conventions
- directory layout rules
- patterns to follow / patterns to avoid
-->
`,

  "open-loops.md": `# Open Loops

${HEADER_COMMENT}

<!--
Unfinished threads. Things we started but didn't finish. Questions blocked
on the user. Each item should be actionable: what's the next thing someone
(agent or user) would do.
-->
`,

  "references.md": `# References

${HEADER_COMMENT}

<!--
External docs, URLs, libraries consulted. Saves the next agent from
re-searching.
-->
`,
};

export const EMPTY_JSONL = "";

export function initialMeta(sourceTool: string, projectRoot: string) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sourceTool,
    sourceVersion: null as string | null,
    createdAt: now,
    updatedAt: now,
    projectRoot,
  };
}

export function initialFilesManifest() {
  return {
    generatedAt: new Date().toISOString(),
    files: [],
  };
}
