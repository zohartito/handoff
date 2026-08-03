# Retrieval eval fixtures

Each subdirectory is one scenario: a `.handoff/`-shaped corpus plus a human
relevance labelling. `handoff evaluate` (see `src/commands/evaluate.ts`) scores
each registered retrieval strategy against these labels.

## What this measures — and what it does not

This is an **information-retrieval** eval, not an agent eval. It asks one
deterministic question: *given a task and a corpus of corrections/attempts, does
the retriever surface the entries a human labelled RELEVANT to that task?*

It does **not** measure end-to-end agent behaviour, whether the receiving agent
read the primer, or whether acting on the surfaced entries produced a better
result. A high score means the ranking put the right entries in front of the
agent; it says nothing about what the agent then did. The current shipping
ranking is also **task-blind** — it ranks purely by recurrence and recency and
never looks at the task text — so these scenarios measure how well a fixed,
task-independent ordering happens to match per-task human relevance.

## Layout

```
<scenario>/
  task.md          # the current task (mirrors .handoff/task.md)
  corrections.md   # corpus of corrections (mirrors .handoff/corrections.md)
  attempts.md      # corpus of failed attempts (mirrors .handoff/attempts.md)
  labels.json      # human relevance labels (see below)
```

`corrections.md` and `attempts.md` use the exact on-disk format that
`handoff correct` and `handoff attempt` emit: a `## <ISO-timestamp>` header per
entry, `**field:**` labels, and a trailing `---`. The eval pools the entries
from both files into one corpus.

## Entry ids

An entry's id is the text of its `## <ISO-timestamp>` header (e.g.
`2026-01-03T09:12:00Z`). Timestamps are unique within a scenario across both
files, so the id identifies exactly one entry.

## Label format (`labels.json`)

```jsonc
{
  "description": "Why these entries are (ir)relevant to the task — prose.",
  "k": 5,                       // optional: retrieval cutoff for this scenario
                                //   (how many slots the primer has). Defaults
                                //   to 5; --k on the CLI overrides both.
  "relevant":   ["<id>", ...],  // entry ids that SHOULD be surfaced
  "irrelevant": ["<id>", ...]   // optional: ids that should NOT be (documentation
                                //   only — scoring treats any non-relevant id as
                                //   a miss regardless of whether it is listed here)
}
```

`relevant` may be empty — that is the "nothing is relevant" case, where the
ideal retriever abstains. With an empty relevant set, recall is defined as 1
(vacuously) and precision is the discriminating metric.

## Metrics (per scenario, then macro-averaged)

- **precision** = relevant hits / entries returned (at cutoff `k`)
- **recall**    = relevant hits / relevant total (1 when relevant is empty)
- **F1**        = harmonic mean of precision and recall
- **MRR**       = reciprocal rank of the first relevant entry in the returned
  list (0 if none; 1 when the relevant set is empty and the retriever returns
  nothing)

Scoring is deterministic and dependency-free. See `tests/evaluate.test.ts` for
the hand-computed metric checks.
