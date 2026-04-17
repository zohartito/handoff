# scripts — keyboard shortcut & tray launchers

Optional integration artifacts. `handoff` works fine without them — these just
let you trigger `handoff switch <tool>` from a global hotkey or system tray
instead of typing it into a terminal.

None of these ship with the npm package. Copy the file you need, bind a
shortcut, done.

## What each file is

| File | Platform | Purpose |
|------|----------|---------|
| `handoff-switch.ahk` | Windows | AutoHotkey v2 hotkey script. `Win+Shift+H` prompts for a tool and runs `handoff switch <tool>` in the active Explorer folder (or `%USERPROFILE%`). |
| `handoff-switch.applescript` | macOS | AppleScript that prompts for a tool and runs `handoff switch <tool>` in Terminal, scoped to the Finder's frontmost folder when possible. |
| `handoff-switch.desktop` | Linux | XDG `.desktop` entry that invokes `handoff-switch.sh`. |
| `handoff-switch.sh` | Linux | Companion wrapper for the `.desktop` file. Prompts via `zenity` / `kdialog` / stdin and runs `handoff switch` in the current working directory. |

## Install & bind

### Windows

1. Install [AutoHotkey v2](https://www.autohotkey.com/).
2. Save `handoff-switch.ahk` anywhere (e.g. `%USERPROFILE%\Scripts\`).
3. Double-click to run it, or drop a shortcut into `shell:startup` so it's
   always active on login.
4. Default hotkey is `Win+Shift+H`. Edit the `#+h::` line in the script to
   change it (`#` = Win, `!` = Alt, `^` = Ctrl, `+` = Shift).
5. Optional: use AutoHotkey's "Compile Script" tool to produce a standalone
   `.exe` so other machines don't need AutoHotkey installed.

### macOS

Pick whichever flow is already part of your setup:

- **Script Editor → .app**: open `handoff-switch.applescript` in Script
  Editor, `File > Export…`, File Format: **Application**. Drop the `.app`
  into `/Applications`. Bind it via *System Settings > Keyboard > Keyboard
  Shortcuts > App Shortcuts*.
- **Automator Quick Action**: Automator > New > Quick Action > Run
  AppleScript, paste the body from `handoff-switch.applescript`, save as
  "handoff switch". Bind a hotkey in *System Settings > Keyboard > Keyboard
  Shortcuts > Services*.
- **Alfred / Raycast / Shortcuts**: easiest path — wrap
  `handoff switch <tool>` in a script action and assign a hotkey there.
  You don't need the AppleScript file in that case.

### Linux

1. Copy `handoff-switch.sh` to `~/.local/bin/` and mark it executable
   (`chmod +x ~/.local/bin/handoff-switch.sh`).
2. Copy `handoff-switch.desktop` to `~/.local/share/applications/`.
3. Bind a keyboard shortcut in your desktop environment's settings
   (GNOME: *Settings > Keyboard > Shortcuts > Custom*; KDE: *System Settings
   > Shortcuts > Custom Shortcuts*). Point it at `handoff-switch.sh`.
4. The wrapper prompts via `zenity` or `kdialog` if available; otherwise it
   reads from stdin (run from a terminal in that case).

## How it's wired to `handoff switch`

Each script resolves a tool name (`claude-code`, `cursor`, `codex`, `gemini`,
`generic`), picks a working directory (active file-manager folder when
available, else `$HOME` / `%USERPROFILE%`), and runs `handoff switch <tool>`
in a terminal window. From there, the `handoff` CLI does the normal save +
prime + clipboard + launch.
