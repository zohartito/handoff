type Tool = "claude-code" | "cursor";

type InstallOpts = { tool: Tool };

export async function install(opts: InstallOpts): Promise<void> {
  if (opts.tool === "claude-code") {
    printClaudeCode();
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

## Verify

${"```"}bash
handoff init --from claude-code
handoff status
${"```"}

Open a new Claude Code session in the project — the primer loads
automatically in the new session's context.
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
handoff prime --tool cursor | pbcopy   # macOS
handoff prime --tool cursor | clip     # Windows
${"```"}

Then paste into a Cursor chat as your first message.
`);
}
