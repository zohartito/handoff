# Claude Code Desktop + Obsidian vault — session handoff prompts

Use these copy-paste blocks when **Claude Desktop** (or any paste-first agent) is working against a project that uses `handoff`, with your **Obsidian** vault holding shared context. Replace placeholders once per project.

**Path roots (folder / username changed from older machines — use what matches *this* PC):**

| Platform | Vault root `VAULT` |
|----------|--------------------|
| **Windows** | `C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\` |
| **macOS** | `/Users/zohar_4ta16fp/SynologyDrive/Obsidian/Brain/` |

**Per-project folder** under the vault (one folder per code project you track in Obsidian):

- `VAULT/Projects/<ProjectFolder>/` — must contain at least `HANDOFF.md` and a roadmap (`roadmap.md` or `ROADMAP.md`).

Fill in: `<ProjectFolder>` (e.g. `my-app`, `Grasshopper-AI-Plugin`).

**Optional:** if your vault keeps `AGENT_INSTRUCTIONS.md` under a different name or path, adjust that single line in the START block.

---

## START — new Claude Desktop session (any project on handoff)

Copy verbatim, then only substitute `VAULT` and `<ProjectFolder>` (and roadmap filename if needed).

```text
Read these files in my Obsidian vault — prior session + project context:

{{VAULT}}AGENT_INSTRUCTIONS.md
{{VAULT}}.handoff/task.md
{{VAULT}}.handoff/progress.md
{{VAULT}}.handoff/decisions.md
{{VAULT}}.handoff/corrections.md
{{VAULT}}.handoff/ingested-context.md
{{VAULT}}Projects/<ProjectFolder>/HANDOFF.md
{{VAULT}}Projects/<ProjectFolder>/roadmap.md

(If the roadmap is named ROADMAP.md instead, use that file.)

Then tell me:
1. Where this project stands — current phase or milestone (if the roadmap uses phases), plus what's already done. If the project is **new to handoff** and `.handoff/` or `ingested-context.md` is thin, say that explicitly; infer only from HANDOFF, roadmap, and what’s in those files — don't invent history.
2. What decisions are locked in (don't re-litigate).
3. What's blocked and why.
4. Three concrete "Next step" options with your recommended default.
5. Ask me which one I want to tackle.

Don't write or edit any files until I pick one.
```

**Example (Windows) after substitution:**

```text
Read these files in my Obsidian vault — prior session + project context:

C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\AGENT_INSTRUCTIONS.md
C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\.handoff\task.md
C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\.handoff\progress.md
C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\.handoff\decisions.md
C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\.handoff\corrections.md
C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\.handoff\ingested-context.md
C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\Projects\My-Project\HANDOFF.md
C:\Users\zohar_4ta16fp\SynologyDrive\Obsidian\Brain\Projects\My-Project\roadmap.md
...
```

**macOS** — same file names; only the root path changes to `/Users/zohar_4ta16fp/...` with forward slashes.

---

## END — before you close the session

```text
Update these files with what we did, decided, and corrected this session:

{{VAULT}}.handoff/progress.md — what we did
{{VAULT}}.handoff/decisions.md — any new decisions
{{VAULT}}.handoff/corrections.md — things I pushed back on
{{VAULT}}.handoff/task.md — the new "current task / next step"

Also append a session entry to today's daily log at {{VAULT}}Daily/YYYY-MM-DD.md (use today's date in the filename).
```

---

## RUSH / token limit — no START this session

Use when the thread is long, the context window is almost full, or you **never** pasted the **START** prompt—so the model was not asked to read `AGENT_INSTRUCTIONS` + `.handoff/` at the beginning. This block **prioritizes writing state to disk** over chatty recap.

**Substitute** `VAULT` and `<ProjectFolder>` as in the other sections. If the model cannot reach the project files, still update vault `.handoff/`; mention project files as “if paths exist, also…”.

```text
We're at token/context limits and I did NOT use the normal START handoff this session.

Do this in order, be brief in chat — spend your remaining output on file edits, not a long essay:

1. If you can read files: skim {{VAULT}}AGENT_INSTRUCTIONS.md, {{VAULT}}.handoff/*.md, and {{VAULT}}Projects/<ProjectFolder>/HANDOFF.md (and roadmap if present) just enough to merge new info without stomping existing structure.

2. Update these (append or edit — don't wipe prior content without cause):
   - {{VAULT}}.handoff/progress.md — what we did THIS session (bullet list)
   - {{VAULT}}.handoff/decisions.md — new decisions; {{VAULT}}.handoff/corrections.md — my pushback
   - {{VAULT}}.handoff/task.md — single clear "next step" for the next session
   - {{VAULT}}.handoff/ingested-context.md — if this thread had important context that isn't in those files, add a short dated paragraph so the next agent doesn't need this chat (optional but encouraged when we're starved for context)

3. Append a few lines to {{VAULT}}Daily/YYYY-MM-DD.md (today's date) summarizing the session.

4. In your reply, only: (a) list which files you updated, (b) one-sentence "next step", (c) anything blocked.

If you truly cannot write files, output the raw markdown for each file I should paste manually — still structured as above.
```

**Even tighter (paste when almost no tokens left):**

```text
Token emergency — no prior START. Update {{VAULT}}.handoff/progress, decisions, corrections, task, and append to Daily/today. Add a short blurb to ingested-context if the thread has facts not in handoff. Chat reply: filenames touched + one-line next step only.
```

---

## How it works

- **START** — Read vault + project files first; agent summarizes before editing (use when the session is fresh).
- **END** — Normal close; update logs when you had context from the start.
- **RUSH** — We skipped START or context is full; **write state first**, keep chat minimal.
- **Vault `.handoff/`** holds cross-session state: at minimum `task`, `progress`, `decisions`, `corrections`, and `ingested-context` so nothing from pasted/ingested chats is lost.
- **Project `HANDOFF.md` + roadmap** in `Projects/<ProjectFolder>/` anchor the *code* project's intent and plan.

If you work **directly in a repo** (not the Obsidian copy), the same flow applies using that repo’s `.handoff/` paths instead of `VAULT/.handoff/`.
