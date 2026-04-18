type Tool = "claude-code" | "claude-desktop" | "cursor";

type UninstallOpts = { tool: Tool };

export async function uninstall(opts: UninstallOpts): Promise<void> {
  if (opts.tool === "claude-code") {
    printClaudeCode();
  } else if (opts.tool === "claude-desktop") {
    printClaudeDesktop();
  } else if (opts.tool === "cursor") {
    printCursor();
  } else {
    console.error(`unknown tool: ${opts.tool}`);
    process.exitCode = 1;
  }
}

function printClaudeCode(): void {
  console.log(`# Remove Claude Code integration

This command only prints instructions — it does not modify any files.

## 1. Edit your settings.json

Check both locations (you may have hooks in either or both):

- user-global: \`~/.claude/settings.json\`
- project:     \`.claude/settings.json\` (at project root)

Remove the three handoff entries from the \`hooks\` object:

${"```"}json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "handoff hook session-start"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "handoff hook stop"
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "matcher": "rate_limit",
        "hooks": [
          {
            "type": "command",
            "command": "handoff hook rate-limit"
          }
        ]
      }
    ]
  }
}
${"```"}

Delete just these three entries. If other hooks live in the same arrays,
keep those. If \`hooks\` becomes empty, you can remove the whole key.

## 2. Optionally remove the CLAUDE.md section

If you appended a "Handoff logging" section to your project \`CLAUDE.md\`
(or \`~/.claude/CLAUDE.md\`), delete it manually.

## 3. Optionally remove .handoff/ from the project

The \`.handoff/\` directory stays until you delete it. Removing it loses
all logged state. If you want to wipe it:

${"```"}bash
rm -rf .handoff
${"```"}

## Verify

${"```"}bash
handoff doctor
${"```"}

The "claude code hooks" section should report no handoff hooks.
Open a new Claude Code session — the primer should no longer auto-load.
`);
}

function printClaudeDesktop(): void {
  console.log(`# Remove Claude Desktop integration

This command only prints instructions — it does not modify any files.

Claude Desktop integration is all manual config inside the app, so
cleanup is too.

## 1. Remove the handoff block from your Project's custom instructions

In Claude Desktop, open the Project for this codebase, then **Edit
custom instructions** and delete the "This project uses \`handoff\`..."
block you added during install.

## 2. Detach \`.handoff/\` files from the Project (if you uploaded them)

If you uploaded \`.handoff/*.md\` files as Project attachments, remove
them from the Project now. If you rely on filesystem MCP instead,
there's nothing to detach — just stop pasting the primer.

## 3. (Optional) Remove the Project entirely

If you made the Project only for handoff integration, you can delete it
from the Claude Desktop Projects list. Conversations inside the Project
will still exist, they just won't have the custom instructions applied.

## 4. Optionally remove .handoff/ from the project

The \`.handoff/\` directory stays until you delete it. Removing it loses
all logged state. If you want to wipe it:

${"```"}bash
rm -rf .handoff
${"```"}

## Verify

Open a new conversation in the Project and confirm Claude Desktop no
longer references \`handoff\` commands or \`.handoff/\` files.
`);
}

function printCursor(): void {
  console.log(`# Remove Cursor integration

This command only prints instructions — it does not modify any files.

## 1. Edit your .cursorrules

Open \`.cursorrules\` at the project root and remove the handoff section.
It looks like this:

${"```"}
This project uses \`handoff\` for portable session state across AI tools.

Before starting work, run \`handoff prime --tool cursor\` to load prior context.

As you work, log to the handoff:
- \`handoff attempt "tried X" --error "trace" --fix "what worked"\` on failures
- \`handoff decide "chose X" --because "reason"\` on meaningful choices
- \`handoff correct "what I did" --user-said "feedback"\` when the user corrects you
${"```"}

If that leaves the file empty, you can delete it.

## 2. Optionally remove .handoff/ from the project

The \`.handoff/\` directory stays until you delete it. Removing it loses
all logged state. If you want to wipe it:

${"```"}bash
rm -rf .handoff
${"```"}

## Verify

${"```"}bash
grep -i handoff .cursorrules || echo "no handoff references"
${"```"}

Open a new Cursor chat — it should no longer reference handoff commands.
`);
}
