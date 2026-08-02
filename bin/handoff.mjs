#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

// node:sqlite (used by `ingest --from cursor`) emits an ExperimentalWarning
// on first load. Suppress that single warning so ingest output to stdout is
// not polluted. All other warnings pass through unchanged.
const _origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === "string" ? warning : warning?.message ?? "";
  if (/SQLite is an experimental feature/.test(msg)) return;
  return _origEmitWarning.call(process, warning, ...rest);
};

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "..", "dist", "cli.js");
const source = join(here, "..", "src", "cli.ts");

if (existsSync(compiled)) {
  await import(pathToFileURL(compiled).href);
} else {
  const { tsImport } = await import("tsx/esm/api");
  await tsImport(pathToFileURL(source).href, import.meta.url);
}
