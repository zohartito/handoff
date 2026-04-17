# Cursor agent instruction — handoff switch

Cursor has no standardized slash-command format yet, so this is an agent
instruction snippet rather than a file Cursor loads by convention. Paste
the block below into your project `.cursorrules` (or the equivalent custom
instructions field in Cursor's settings). The agent will then treat a
"switch to <tool>" utterance as a trigger to run `handoff switch`.

```
## Handoff switch shortcut

When the user says "switch to <tool>" or "/handoff-switch <tool>" where
<tool> is one of `claude-code`, `cursor`, `codex`, `gemini`, or `generic`,
run `handoff switch <tool>` via the terminal tool and print the last line
of its output as confirmation.

If the tool name is missing or not in the allowed list, ask which tool to
switch to before running anything.

Do not write anything to `.handoff/` yourself — `handoff switch` already
refreshes `environment.md` via `handoff save`.
```

Once Cursor ships a real custom-command surface, this instruction can be
replaced with a proper command definition. For now, the plain-English
trigger phrase is the most reliable path.
