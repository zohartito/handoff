# Task

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works.
-->

## Goal

Build `handoff`: a portable session-state CLI that travels with a project as
`.handoff/`, so any AI coding tool (Claude Code, Cursor, Codex, Gemini) can
pick up work where the last tool left off — with full knowledge of what was
tried, what failed, what was decided, and what the user corrected.

## Why

AI coding tools hit rate limits, drop context, or need to be swapped
mid-task. Today, every switch = "explain everything again". This tool is
the agent-to-agent handoff that eliminates that.

## Done looks like (v1)

- `handoff init` scaffolds `.handoff/` in any project — **done**
- `handoff attempt|decide|correct|save|status` lifecycle commands — **done**
- `handoff prime --tool <tool>` emits a primer for any target tool — **done**
- `handoff install --tool claude-code` prints integration recipe — **done**
- Claude Code hooks (SessionStart / Stop / StopFailure) auto-inject the
  primer into every new session — **done**
- `handoff ingest --from claude-code` pulls past session transcripts into
  `.handoff/` — **done**
- `handoff ingest --from cursor` pulls past Cursor sessions (reads
  `state.vscdb` via built-in `node:sqlite`) — **done**
- Real cross-tool handoff test: start in one tool, hand off mid-task, verify
  the other picks up without re-explanation — **next**
- Publish to GitHub + `npm install -g` — **after cross-tool test**

## Constraints

- File format stays human-readable markdown + JSON/JSONL. No binary DBs.
- `.handoff/` is portable: copy the folder, keep the context.
- Tool-agnostic primer — no Claude-specific idioms in the shared files.
- Zero runtime dependencies beyond Node + commander.
- Windows must work (stdout flush quirk, path encoding quirks — both solved).

## Next task (for whichever tool picks this up)

**Current mission: live mac + linux validation pass of `@zohartito/handoff@0.4.0`.**

This is the last open item on the roadmap (v1.6). The code was platform-audited
but never exercised on real Apple/Linux hardware. Windows side is fully shipped.

This file itself is the handoff proof: Windows-Claude stopped here at
2026-04-17. Mac-Claude (that's you, if you're reading this on macOS) continues
from here with full context — no re-explanation.

### What needs to be validated on macOS

1. **Install + version.** `npm install -g @zohartito/handoff@0.4.0`, then
   `handoff --version` → should print `0.4.0`. If it prints anything else, the
   `pkgVersion` read in `src/cli.ts` is mis-resolving on macOS (path to
   `package.json` relative to `dist/cli.js`). File it as a `handoff correct`.

2. **Clipboard cascade.** `cd` into this repo, then
   `handoff switch codex --no-launch`. It should find `pbcopy` and copy the
   primer silently. Verify with `pbpaste | head -5` — you should see the
   primer preamble. If the switch command prints "copy manually", the macOS
   clipboard branch in `src/commands/switch.ts` isn't firing.

3. **Launcher PATH resolution.** `handoff switch cursor` (drop `--no-launch`)
   should open Cursor.app if it's installed. Likewise `handoff switch codex`
   should resolve `codex` on PATH. Log any that fail with `handoff attempt`.

4. **Cursor FS layout.** If you have Cursor installed and have used it at
   least once, run `handoff ingest --from cursor --list`. It should find
   sessions at `~/Library/Application Support/Cursor/User/workspaceStorage/`.
   If it looks in the Windows `%APPDATA%` path instead, `cursorUserDir()` in
   `src/adapters/cursor.ts` is picking the wrong branch — check `process.platform`.

5. **Claude Code project-path encoding under Unix roots.** The Windows path
   encoder replaces `:` and `\`. Under Unix (`/Users/you/projects/foo`), the
   encoder must handle `/` and leading-slash. Run
   `handoff ingest --from claude-code --list` — if it prints "no sessions
   found" despite you having used Claude Code in this repo on mac, check
   `encodeProjectPath()` (or equivalent) in `src/adapters/claude-code.ts`.

6. **Obsidian sync (bonus).** If your Obsidian vault is on the same
   Synology sync mount, `handoff obsidian sync --vault <vault-path>` should
   write Daily / Decisions / Rules notes into it. Verify file creation.

### How to report findings back to Windows-Claude

- Every bug: `handoff correct "<what>" --user-said "<mac-specific symptom>" --lesson "<rule>"`.
- Every successful verification: `handoff attempt "validated X on macOS" --fix "works as specified"`.
- When the validation round is done: `handoff save`, commit with a
  `chore(v1.6): mac validation pass` message, push. Synology will sync the
  `.handoff/` updates back to Windows or push/pull via git — either works.

### If you also have linux (WSL on Windows side, or real linux):

- Same install step. Clipboard test: `handoff switch codex --no-launch` then
  check `wl-paste` (Wayland) or `xclip -o -selection clipboard` (X11).
- If none of `wl-copy` / `xclip` / `xsel` are installed, the cascade should
  end at "copy manually" — not throw.

Once every item above has a `handoff attempt` or `handoff correct` logged,
bump the roadmap v1.6 validation checkbox to `[x]` and ship a patch release.

### Bonus: untracked CI draft

There's a `.github/workflows/ci.yml` sitting untracked in the repo — a
GitHub Actions matrix over `ubuntu-latest` / `macos-latest` / `windows-latest`
that runs the test suite and a pack-and-install smoke test on each. I (Windows-Claude)
wrote it, then the user pointed out that a real macbook with Synology sync is
the actual dogfood path for v1.6 — so the workflow is a belt-and-suspenders
extra, not required. Review it on the mac side; if it looks right, `git add
.github/workflows/ci.yml` and commit it alongside your validation findings.
If not, delete it and move on.
