-- handoff-switch.applescript — macOS launcher for `handoff switch <tool>`.
--
-- What it does
-- ------------
-- Prompts for a target tool, then runs `handoff switch <tool>` via
-- `do shell script`. Tries to use the Finder's frontmost window's folder
-- as the working directory; falls back to $HOME.
--
-- Install
-- -------
-- Option A — save as .app:
--   1. Open Script Editor, paste this file, File > Export… > File Format: Application.
--   2. Move the .app to /Applications or ~/Applications.
--   3. Bind a keyboard shortcut via System Settings > Keyboard > Keyboard Shortcuts
--      > App Shortcuts, or via a launcher like Alfred / Raycast / Shortcuts.
--
-- Option B — Automator Quick Action:
--   1. Automator > New > Quick Action > Run AppleScript.
--   2. Paste the body below, save as "handoff switch".
--   3. System Settings > Keyboard > Keyboard Shortcuts > Services — assign a hotkey.
--
-- Option C — Raycast / Alfred:
--   Wrap `handoff switch <tool>` in a script action and assign a hotkey there.
--   The AppleScript file is not strictly needed in that case.

on run
	set defaultTool to "cursor"
	set toolChoices to {"claude-code", "cursor", "codex", "gemini", "generic"}
	set tool to ""
	try
		set tool to choose from list toolChoices with prompt "Switch to which tool?" default items {defaultTool} without multiple selections allowed
		if tool is false then return
		set tool to item 1 of tool
	on error
		return
	end try

	set cwd to my finderFolderPath()
	if cwd is "" then
		set cwd to (do shell script "echo $HOME")
	end if

	-- Run in Terminal so the user sees the primer confirmation and the launcher output.
	set cmd to "cd " & quoted form of cwd & " && handoff switch " & quoted form of tool
	tell application "Terminal"
		activate
		do script cmd
	end tell
end run

-- Returns the POSIX path of the Finder's frontmost window target, or "" if none.
on finderFolderPath()
	try
		tell application "Finder"
			if (count of windows) is 0 then return ""
			set theTarget to target of front window
			return POSIX path of (theTarget as alias)
		end tell
	on error
		return ""
	end try
end finderFolderPath
