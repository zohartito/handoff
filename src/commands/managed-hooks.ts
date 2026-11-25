/** Managed commands shared by setup, diagnostics and manual removal. */
export const MANAGED_HOOKS = [
  { event: "SessionStart", subcmd: "session-start", matcher: "*", optional: false },
  { event: "Stop", subcmd: "stop", matcher: "*", optional: false },
  { event: "PreCompact", subcmd: "pre-compact", matcher: "*", optional: true },
  { event: "StopFailure", subcmd: "rate-limit", matcher: "rate_limit", optional: false },
  { event: "UserPromptSubmit", subcmd: "user-prompt-submit", matcher: "*", optional: true },
] as const;

export function managedHookSettings(includeReinjection = false): object {
  return { hooks: Object.fromEntries(MANAGED_HOOKS
    .filter((h) => includeReinjection || h.event !== "UserPromptSubmit")
    .map((h) => [h.event, [{ matcher: h.matcher, hooks: [
      { type: "command", command: `handoff hook ${h.subcmd}` },
    ] }]])) };
}
