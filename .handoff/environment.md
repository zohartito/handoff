# Environment

<!--
This file is part of a .handoff/ artifact. It is intended to be read and
updated by an AI coding agent (Claude Code, Cursor, Codex, Gemini, etc.)
as it works. When an agent picks up this project, it should read every
file in this directory before taking action.
-->

<!--
The runtime context. `handoff save` auto-refreshes the machine-readable
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

_refreshed: 2026-04-17T03:48:11.891Z_
- os: win32 10.0.26200 (x64)
- user: zohar_4ta16fp
- node: v24.14.0
- cwd: `C:\Users\zohar_4ta16fp\handoff`
- git branch: `main`

### git status

```
M .handoff/meta.json
 M .handoff/progress.md
 M ROADMAP.md
 M src/commands/prime.ts
```

### recent commits

```
ca0a849 feat(v1.5): ingest --all, compact primer, schema migration, cross-platform
67e0c2d fix(ingest): scope 'latest' session to requested project path
d9df16e build: make prepublishOnly cross-platform (use node -e instead of rm -rf)
a8b9dca build: isolate test build output from publish tarball
168c400 initial commit: handoff v0.1.0
```

### diff stat

```
.handoff/meta.json    |  2 +-
 .handoff/progress.md  | 52 ++++++++++++++++++++++++++++++++++++++++-----------
 ROADMAP.md            | 12 ++++++------
 src/commands/prime.ts |  4 +++-
 4 files changed, 51 insertions(+), 19 deletions(-)
```

## Human notes
