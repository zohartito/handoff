# Handoff plugin tombstone

The Handoff plugin distribution is retired. This directory contains no plugin
manifest, automatic hook registration, MCP registration, executable shim,
global-command fallback, environment-variable override, or installation
instruction.

If an older checkout installed a Handoff plugin, remove that existing plugin
through the host product's documented plugin-management UI. Preserve historical
`.handoff` records; the frozen Handoff CLI does not inspect or remove them.
