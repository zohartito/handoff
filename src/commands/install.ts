type Tool = "claude-code" | "claude-desktop" | "cursor";

type InstallOpts = { tool: Tool };

export async function install(opts: InstallOpts): Promise<void> {
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
  console.log(`# Claude Code integration

Two steps.

## 1. Add hooks to \`~/.claude/settings.json\` (or project \`.claude/settings.json\`)

Three hooks:
- \`SessionStart\` → auto-injects the handoff primer into every new session
  (only when the project has a \`.handoff/\` directory; silent no-op otherwise)
- \`Stop\` → \`handoff save\` refreshes environment snapshot on session end
- \`StopFailure\` with \`rate_limit\` matcher → logs the rate-limit event and
  reminds you to swap tools

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

Note on rate-limit: Claude Code has no *proactive* rate-limit hook (no
"80% warning"). \`StopFailure\` fires *after* you hit the limit. That's
still useful — it guarantees the handoff captures the rate-limit event
and reminds you to swap tools.

## 2. Teach the agent to log as it works

Append this to your project \`CLAUDE.md\` (or \`~/.claude/CLAUDE.md\`):

${"```"}markdown
## Handoff logging

This project uses \`handoff\` for portable session state. As you work:

- When something fails and you recover, log it:
  \`handoff attempt "tried X" --error "verbatim trace" --fix "what worked"\`
- When you make a meaningful design choice, log it:
  \`handoff decide "chose X" --because "reason" --alt Y Z\`
- When the user corrects you, log it:
  \`handoff correct "what I did" --user-said "their feedback" --lesson "..."\`

Keep entries small and specific. Don't log trivial things. Log anything a
future agent (or you, next session) would benefit from knowing.
${"```"}

## 3. (Optional) Add the \`/handoff-switch\` slash command

The repo ships a template at \`templates/claude-commands/handoff-switch.md\`.
Copy it to either location so Claude Code picks it up:

- Per-project: \`.claude/commands/handoff-switch.md\`
- User-global: \`~/.claude/commands/handoff-switch.md\`

Then \`/handoff-switch <tool>\` inside any Claude Code session runs
\`handoff switch <tool>\` via the Bash tool without leaving the session.

## Verify

${"```"}bash
handoff init --from claude-code
handoff status
${"```"}

Open a new Claude Code session in the project — the primer loads
automatically in the new session's context.
`);
}

function printClaudeDesktop(): void {
  console.log(`# Claude Desktop integration

Claude Desktop is a GUI app with no hook system, so there's nothing to
wire up automatically — integration is three manual steps.

## 1. Create a Claude Desktop Project for this folder

In Claude Desktop, open **Projects** and make a new Project for this
codebase. Projects persist custom instructions and attached files across
conversations — that's the hook we lean on here.

Suggested Project-level custom instructions:

${"```"}
This project uses \`handoff\` for portable session state across AI tools.

At session start, read every file under \`.handoff/\` before responding:
task.md, progress.md, decisions.md, attempts.md, corrections.md,
open-loops.md, environment.md, identity.md, codebase-map.md,
references.md.

At session end, dump this conversation to \`.handoff/transcript.md\` and
update task.md / progress.md / decisions.md / corrections.md with
anything new from the session.
${"```"}

## 2. Give Claude Desktop access to \`.handoff/\`

You have two options — pick whichever matches your setup:

### Option A: filesystem MCP (recommended)

If you have the filesystem MCP server configured and pointed at this
project root, Claude Desktop can read and write \`.handoff/\` files
directly. In that case new conversations just need the primer:

${"```"}bash
handoff prime --tool claude-desktop | clip       # Windows
handoff prime --tool claude-desktop | pbcopy     # macOS
handoff prime --tool claude-desktop | wl-copy    # Linux (Wayland)
${"```"}

Paste the primer as your first message. Claude Desktop will read
\`.handoff/\` via filesystem MCP on its own.

### Option B: attach files to the Project

If you don't run the filesystem MCP server, open the Project in Claude
Desktop and upload the \`.handoff/*.md\` files as Project attachments.
They'll be in context for every conversation in the Project.

On each handoff, re-upload any files that changed (or use
\`handoff save\` locally first to refresh \`environment.md\`).

## 3. (Optional) Obsidian MCP

If you run the Obsidian MCP server, mention your vault path in the
Project's custom instructions — e.g. "my Obsidian vault is at
\`/Users/me/Obsidian/brain\`". Then \`handoff obsidian sync\` decisions
and rules become queryable from inside any Claude Desktop conversation.

## Verify

${"```"}bash
handoff init --from claude-code       # (if not already done)
handoff status
${"```"}

Open a new conversation in your Claude Desktop Project, paste the primer,
and confirm it reads a file from \`.handoff/\` before answering.
`);
}

function printCursor(): void {
  console.log(`# Cursor integration

Cursor doesn't have Claude Code's hook system, so integration is two steps:

## 1. Add handoff awareness to your .cursorrules

Put this in \`.cursorrules\` at the project root:

${"```"}
This project uses \`handoff\` for portable session state across AI tools.

Before starting work, run \`handoff prime --tool cursor\` to load prior context.

As you work, log to the handoff:
- \`handoff attempt "tried X" --error "trace" --fix "what worked"\` on failures
- \`handoff decide "chose X" --because "reason"\` on meaningful choices
- \`handoff correct "what I did" --user-said "feedback"\` when the user corrects you
${"```"}

## 2. Prime a Cursor session manually

When picking up work from another tool:

${"```"}bash
handoff prime --tool cursor | pbcopy    # macOS
handoff prime --tool cursor | clip      # Windows
handoff prime --tool cursor | wl-copy   # Linux (Wayland)
handoff prime --tool cursor | xclip -selection clipboard   # Linux (X11)
${"```"}

Then paste into a Cursor chat as your first message.

## 3. (Optional) Teach the agent to recognize a "switch to <tool>" trigger

The repo ships a template at \`templates/cursor/slash-handoff-switch.md\`.
Copy the instruction block from that file into your \`.cursorrules\` so the
Cursor agent treats "switch to <tool>" (or \`/handoff-switch <tool>\`) as a
request to run \`handoff switch <tool>\` via its terminal tool.
`);
}
