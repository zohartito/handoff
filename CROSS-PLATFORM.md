# Cross-Platform Status

`handoff` was developed on Windows. This doc records what has been validated
per platform and what still needs live testing.

## Validated

**Windows** — full end-to-end on the original developer box (dev through 0.7.x).

**macOS** — full live pass on real hardware (Apple Silicon, Darwin 27, Node
22.22.3) at 0.7.1 on 2026-07-31, on top of the original v1.6 validation
round (2026-04-17):

- `npm ci` + `npm run build` + `npm test`: clean, 160/160 tests pass.
- Every CLI command exercised end-to-end in a scratch project: `init`,
  `status`, `save`, `attempt`, `decide`, `correct`, `capture`, `prime`
  (all tools), `install`/`uninstall`, `doctor`, `patterns`, `search`.
- `handoff --version` resolves correctly from the package root (0.7.1).
- Clipboard: `handoff switch codex --no-launch` copied the full primer via
  `pbcopy`; verified independently with `pbpaste`.
- `ingest --from claude-code --list` found real sessions under
  `~/.claude/projects/` (unix path encoding confirmed).
- `ingest --from cursor|codex|gemini --list` each scanned the correct
  macOS data directories (`~/Library/Application Support/Cursor/...`,
  `~/.codex/sessions/` — 1569 rollouts parsed, `~/.gemini/tmp/`) and
  degraded gracefully (clean exit-1 message) when no sessions matched.

**Linux** — automated only: the CI matrix (ubuntu × Node 22/24) runs the
full test suite green. Live desktop paths (clipboard cascade, launchers)
have not run on real Linux hardware — see "Requires live testing".

The automated test suite exercises the platform-independent code paths
(parsing, rendering, path comparison logic) on all three OSes via CI.
Unit tests cover:

- `cwdMatchesProject` / `normalizeForCompare` — including the new
  platform-conditional case-sensitivity branches (win32, darwin, linux
  all covered explicitly).
- Adapter parsing of Claude Code, Cursor, Codex, and Gemini session
  fixtures (shared output shape verified).
- Prime compaction, render parity, migration, ingest-all orchestration.

The spawn-based code paths (clipboard, tool launch) are NOT exercised by
the test suite — see "Requires live testing" below.

## Fixed inline

Surgical patches applied in this audit:

1. **`src/commands/ingest.ts` — `cwdMatchesProject` case sensitivity.**
   The previous implementation unconditionally lowercased both sides of
   the comparison. Correct on Windows / macOS (default FS is
   case-insensitive), but wrong on Linux where `/Users/foo` and
   `/Users/Foo` are two different directories. Made the lowercasing
   platform-conditional via a new `normalizeForCompare(p, plat)` helper
   that accepts a platform parameter (for testability — no global
   monkey-patching of `os.platform()`). Both helpers now exported.

2. **`src/adapters/cursor.ts` — `cursorPaths()` hardcoded Windows layout.**
   Previously built `~/AppData/Roaming/Cursor/User`, which only exists on
   Windows. Refactored into `cursorUserDir()` with three branches
   following Electron's per-OS convention:
     - Windows: `%APPDATA%\Cursor` (env var, with `~/AppData/Roaming`
       fallback).
     - macOS: `~/Library/Application Support/Cursor`.
     - Linux: `$XDG_CONFIG_HOME/Cursor` (with `~/.config` fallback).

3. **`src/commands/switch.ts` — Linux clipboard fallback chain.**
   Previously only spawned `xclip`, which isn't installed by default on
   most Wayland-first distros. Now tries in order:
     1. `wl-copy` (Wayland — the modern default)
     2. `xclip -selection clipboard` (X11 classic)
     3. `xsel --clipboard --input` (X11 fallback)
   First one that succeeds wins. macOS still uses `pbcopy`, Windows still
   uses `clip`. The stderr hint printed when nothing works was updated to
   list all three linux options.

4. **`src/commands/hook.ts` — rate-limit hint was Windows-only.**
   The rate-limit hook printed `handoff prime --tool codex | clip` which
   is Windows-specific. Now emits `clip` / `pbcopy` / `wl-copy` based on
   `platform()`.

5. **`src/commands/install.ts` — cursor install docs.**
   The printed help listed only macOS (`pbcopy`) and Windows (`clip`)
   clipboard commands. Added linux equivalents for Wayland and X11.

6. **Tests added (`tests/ingest-claude-code.test.ts`)**
   - `cwdMatchesProject: platform-conditional case sensitivity` — asserts
     linux treats `/Users/Foo` and `/Users/foo` as different dirs, while
     darwin and win32 treat them as equivalent.
   - `normalizeForCompare: lowercases only on win32/darwin` — direct
     coverage of the helper with all three platforms.

## Requires live testing

Remaining code paths that are CORRECT on paper but have not been executed
on live hardware.

### macOS (mostly validated — see "Validated" above)

Still outstanding, all in the launch-spawn path (validation runs used
`--no-launch`):

- **`handoff switch <tool>` detached launch.** Verify `cursor <cwd>` /
  `claude` / `codex` / `gemini` actually spawn detached and open when the
  binaries are on PATH.
- **`handoff ingest --from cursor` with real data.** The adapter scanned
  the correct `~/Library/Application Support/Cursor/` layout, but a parse
  of a real populated `state.vscdb` on macOS hasn't been observed yet.

### Linux

All launcher/clipboard paths, plus:

- **Clipboard fallback order.** On a Wayland session (GNOME / KDE Plasma
  defaults on most distros), `wl-copy` should succeed and the x-servers
  should never be tried. On an X11 session, `wl-copy` spawn fails (error
  event fires, not a non-zero exit), `xclip` is tried next, and `xsel`
  after that. Verify the cascade actually falls through on `spawn`
  errors and doesn't hang.
- **`xdg-open` vs direct launch.** The current launch code spawns tools
  directly (`cursor`, `claude`, `codex`, `gemini`). On linux, these
  binaries are usually installed as either:
    1. A symlink or wrapper on PATH under those exact names (works)
    2. A snap/flatpak that only responds to `xdg-open` or the full
       app ID (does not work — we'd error out)
  We do NOT currently fall back to `xdg-open`. Verify whether the common
  install methods (npm global for `claude`, deb/rpm for Cursor, etc.)
  put the expected names on PATH. If not, either document the requirement
  ("ensure `cursor`, `claude`, etc. are on PATH") or add an xdg-open
  fallback.
- **Cursor FS layout on linux.** Electron on linux defaults to
  `~/.config/Cursor`, but some Cursor install variants (AppImage,
  Flatpak) may override this to `~/.var/app/com.todesktop.*` or similar.
  If `ingest --from cursor` reports "no Cursor state DB found" on linux
  even when Cursor is installed, check `echo $XDG_CONFIG_HOME` and
  `ls ~/.config/Cursor/User/globalStorage/` to locate the actual path.
- **Case sensitivity in `cwdMatchesProject`.** Log a Claude Code session
  with cwd `/home/user/ProjectFoo`, then run `handoff ingest
  --from claude-code --project /home/user/projectfoo`. On linux the
  scoped filter should NOT match (correct, since they're different
  directories). Verify via `--list` that the session appears only for
  the exact-case project path.

### Both mac and linux

- **`handoff hook session-start`.** Not platform-specific, but worth
  confirming the stdout JSON payload (`hookSpecificOutput`) is accepted
  by Claude Code's posix builds without corruption from any CRLF
  translation.
- **`handoff save`.** `collectGitState` shells out to `git`; trivial on
  any platform with git on PATH, but confirm the captured diff/status
  output renders cleanly (no `\r\n` leaking into markdown code fences).

## Known limitations documented for users

Carried over to README / doctor output where appropriate:

- **`handoff doctor` hook install check** only looks at
  `~/.claude/settings.json` and `.claude/settings.json`. Both are
  cross-platform (Claude Code uses them on all OSes); no change needed.
- **Launcher binaries must be on PATH.** `handoff switch <tool>` assumes
  `cursor`, `claude`, `codex`, `gemini` are resolvable by name. On linux
  with app-packaged installs (flatpak / snap) this may not hold — users
  will see `couldn't launch <tool> automatically — is it installed and
  on PATH?` and need to launch manually after pasting the primer.
- **Linux clipboard requires wl-copy, xclip, or xsel.** If none are
  present, `handoff switch` falls back to printing the
  `handoff prime --tool <x> | <clip-cmd>` hint. Users on headless linux
  boxes (no display server) should use `handoff prime` + their own
  copy method.
- **Ingest paths are best-effort per OS.** `handoff ingest --from cursor`
  on macOS / linux is based on Electron defaults — not verified against
  every Cursor install variant (standalone, flatpak, snap). If a
  non-standard install is used, the adapter will report "no Cursor
  workspace found" and the user should `handoff ingest --from cursor
  --list` to debug, or supply `--project <path>` explicitly.
