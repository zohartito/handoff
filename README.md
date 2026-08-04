# Handoff — product freeze

Handoff is permanently frozen. It no longer reads repository/session state,
writes `.handoff`, starts MCP, installs integrations, resolves executables, or
runs subprocesses. Node does not provide the directory-descriptor primitives
needed to make the former path-based state model safe against replacement races.

The only supported commands are:

```sh
handoff --help
handoff --version
handoff uninstall --tool claude-code
handoff uninstall --tool claude-desktop
handoff uninstall --tool cursor
handoff uninstall --tool codex
```

`uninstall` only prints a manual checklist. It does not edit configuration and
does not delete existing `.handoff` data. Preserve that data as historical
records unless you independently decide how to archive it.

## Removal checklist

Run `handoff uninstall --tool <tool>` for the tool-specific checklist. In
particular, remove every historical integration entry that invokes Handoff:

- Claude Code hook entries in both user and project settings, including
  `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PreCompact`, and
  any custom event variants.
- Claude Code plugin enablement and marketplace entries that installed or
  launched Handoff.
- MCP/server records, launch commands, and environment blocks in Claude Code,
  Claude Desktop, Cursor, Codex, and workspace configuration. For Codex,
  inspect `~/.codex/config.toml` specifically.
- Project instructions, `CLAUDE.md`, `.cursorrules`, rules, aliases, wrappers,
  tasks, and copied primers that mention `handoff` or `.handoff`.

Before manually changing JSON or TOML, make a same-directory backup, edit only
the named Handoff record, validate the resulting configuration, and use a
safe-save/atomic replacement. Do not use recursive deletion commands. The
removal guidance never deletes `.handoff` data.

Do not run `handoff doctor`: it is disabled with every other product command.

## Package boundary

The published package exports only a side-effect-free freeze/removal helper and
the `handoff` refusal-only CLI. The release build compiles only those files;
historical state-processing modules remain source-only for forensics and test
coverage. Deep package imports are blocked by the `exports` map, and
operational modules are omitted from the package tarball.

CI, secret scanning, and agentic PR review are security-disabled pending owner
review of immutable action commit SHAs, permissions, and event scope.

## Existing data

This release intentionally leaves existing `.handoff` directories untouched.
The CLI will not inspect, migrate, or remove them.

## License

MIT. See [LICENSE](LICENSE).
