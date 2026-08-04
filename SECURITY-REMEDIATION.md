# P3 security remediation

This branch extends the P2 product freeze at commit `247029a`. P2 made every
historical stateful CLI command reject before it can inspect a repository,
session transcript, terminal-shaped text, lock, or Obsidian vault.

The P3 decisions are deliberately fail-closed:

- **HND-LOW-01:** the release CLI does not load a renderer for repository or
  transcript content, so it cannot pass that content to an interactive terminal.
- **HND-LOW-02:** the release build contains no session discovery, capture,
  ingest, search, patterns, doctor, or primer implementation. Each historical
  command refuses before input/path processing.
- **HND-LOW-03:** lock acquisition is part of the excluded historical runtime;
  no supported command can acquire, steal, or release a `.handoff` lock.
- **HND-LOW-04:** Obsidian synchronization is part of the excluded historical
  runtime; no supported command can create or overwrite a vault note.
- **HND-HARDEN-01:** all workflows that formerly invoked mutable third-party
  action tags are tombstoned. They contain no `uses:` step, have no permissions,
  and fail until an owner reviews and restores full immutable action SHAs.

The release lifecycle also deletes `dist` before it looks for the local
compiler, builds the frozen allowlist only, and validates that generated and
package surfaces contain no legacy modules. Thus a missing dependency or failed
build removes stale output and refuses packaging rather than reusing it.
Source-distributed plugin manifests, hooks, MCP registrations, environment and
global-command shims, desktop launchers, and operational prompt templates are
removed; only non-executable tombstone documentation remains.

The historical TypeScript stays tracked solely for audit/test evidence and is
compiled only by the test configuration. It is not a supported interface and
must not be reintroduced into the release build without a fresh threat model,
bounded-input design, and security review.

## Owner-only restoration actions

Before restoring a workflow, an owner must choose and document exact reviewed
40-character action commits, least-privilege permissions, trusted event scope,
and offline regression coverage. Before restoring a stateful Handoff feature,
an owner must replace the former path-based design with an audited descriptor-
bound implementation and obtain a new security review.
