; handoff-switch.ahk — AutoHotkey v2 launcher for `handoff switch <tool>`
;
; What it does
; ------------
; Press Win+Shift+H anywhere on Windows. A small InputBox asks which tool to
; switch to (claude-code, cursor, codex, gemini, generic). The script then
; runs `handoff switch <tool>` in the current Explorer window's folder, or
; in %USERPROFILE% if no Explorer window is focused.
;
; Install
; -------
; 1. Install AutoHotkey v2 from https://www.autohotkey.com/
; 2. Save this file anywhere (e.g. %USERPROFILE%\Scripts\handoff-switch.ahk).
; 3. Double-click to run it, or drop a shortcut in
;    shell:startup so the hotkey is always available.
;    Optional: compile to an .exe via AutoHotkey's "Compile Script" tool
;    so it runs without requiring AutoHotkey to be installed elsewhere.
;
; Change the hotkey by editing the `#+h::` line below. Syntax:
;   # = Win, ! = Alt, ^ = Ctrl, + = Shift

#Requires AutoHotkey v2.0

#+h::  ; Win+Shift+H
{
    ; Ask the user which tool.
    prompt := InputBox(
        "Switch to which tool?`n`nclaude-code | cursor | codex | gemini | generic",
        "handoff switch",
        "w320 h150",
        "cursor"
    )
    if (prompt.Result = "Cancel" || Trim(prompt.Value) = "")
        return

    tool := Trim(prompt.Value)

    ; Resolve working directory from the active Explorer window, else fall back.
    cwd := GetExplorerPath()
    if (cwd = "")
        cwd := EnvGet("USERPROFILE")

    ; Run in a visible cmd window so the user sees the primer confirmation
    ; and any launcher output. /K keeps the window open after the command.
    Run('cmd.exe /K "cd /d "' cwd '" && handoff switch ' tool '"', cwd)
}

; Returns the folder path of the focused Explorer window, or "" if none.
GetExplorerPath() {
    hwnd := WinExist("A")
    if (!hwnd)
        return ""

    cls := WinGetClass("ahk_id " hwnd)
    if (cls != "CabinetWClass" && cls != "ExploreWClass")
        return ""

    for window in ComObject("Shell.Application").Windows {
        try {
            if (window.HWND = hwnd)
                return window.Document.Folder.Self.Path
        }
    }
    return ""
}
