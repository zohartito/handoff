import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { resolveHandoffPaths, type HandoffPaths } from "../format/paths.js";
import { exists, readJson, readOrEmpty } from "../util/fs.js";
import { collectGitState, commitsSince, commitsSincePathChange } from "../util/git.js";
import { SCHEMA_VERSION, type Meta } from "../format/types.js";
import { loadMeta } from "../format/migrate.js";

const run = promisify(execFile);

type Level = "ok" | "warn" | "err";
type Check = { level: Level; label: string; detail?: string };

/** Package name this CLI is shipped under. */
const PACKAGE_NAME = "@zohartito/handoff";

/**
 * Warn when this many commits have landed since the last `handoff save`. The
 * normal flow is `handoff save` then `git commit` (which includes the updated
 * meta.json), so a healthy repo already sits at 1 commit "since save" — the
 * threshold is well above that so only a genuinely stale artifact trips it.
 */
const STALE_COMMIT_THRESHOLD = 10;

/**
 * Warn when attempts.md / corrections.md haven't changed in this many commits.
 * Higher than STALE_COMMIT_THRESHOLD because "no new attempts logged" is much
 * weaker evidence of staleness than "no new save".
 */
const STALE_LOG_COMMIT_THRESHOLD = 25;

export async function doctor(opts: { cwd?: string } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  let hasError = false;
  // Hoisted so the staleness section (below the git section) can read the
  // last-save timestamp. Assigned inside the handoffPresent block.
  let meta: Meta | null = null;

  console.log("# handoff doctor");
  console.log();
  console.log(`cwd: ${cwd}`);
  console.log();

  // 1. .handoff/ present
  console.log("## project");
  const handoffPresent = await exists(paths.dir);
  const projectChecks: Check[] = [];
  if (handoffPresent) {
    projectChecks.push({ level: "ok", label: ".handoff/ present" });
  } else {
    projectChecks.push({
      level: "err",
      label: ".handoff/ missing",
      detail: "run `handoff init` to scaffold it",
    });
    hasError = true;
  }

  // 2. meta.json schema version
  if (handoffPresent) {
    meta = await loadMeta(paths.meta);
    if (!meta) {
      projectChecks.push({
        level: "warn",
        label: "meta.json missing or unreadable",
        detail: "run `handoff save` to refresh",
      });
    } else if (meta.schemaVersion === SCHEMA_VERSION) {
      projectChecks.push({
        level: "ok",
        label: `meta.json schema version ${meta.schemaVersion}`,
      });
    } else {
      projectChecks.push({
        level: "warn",
        label: `schema version mismatch (found ${meta.schemaVersion}, expected ${SCHEMA_VERSION})`,
        detail: "re-run `handoff init --force` to migrate (backup first)",
      });
    }

    // 3. Templates not yet filled
    const templateFiles: Array<{ label: string; path: string }> = [
      { label: "task.md", path: paths.task },
      { label: "progress.md", path: paths.progress },
      { label: "decisions.md", path: paths.decisions },
      { label: "attempts.md", path: paths.attempts },
      { label: "corrections.md", path: paths.corrections },
      { label: "identity.md", path: paths.identity },
      { label: "environment.md", path: paths.environment },
      { label: "codebase-map.md", path: paths.codebaseMap },
      { label: "open-loops.md", path: paths.openLoops },
      { label: "references.md", path: paths.references },
    ];

    let filled = 0;
    for (const f of templateFiles) {
      const content = await readOrEmpty(f.path);
      if (stripTemplate(content).trim().length > 0) filled++;
    }
    const total = templateFiles.length;
    if (filled === 0) {
      projectChecks.push({
        level: "warn",
        label: `all ${total} files are still templates`,
        detail: "nothing has been logged yet — start with `handoff decide`, `handoff attempt`, etc.",
      });
    } else {
      projectChecks.push({
        level: "ok",
        label: `${filled}/${total} files have content`,
      });
    }

    // 3b. Stale empty .jsonl files left over from <=0.6 `handoff init`.
    // v0.7 stopped pre-creating these. If they exist and are empty (or just a
    // single newline byte) we flag them so follow-up agents don't open them
    // expecting tool history.
    for (const [label, p] of [
      ["transcript.jsonl", paths.transcript],
      ["tool-history.jsonl", paths.toolHistory],
    ] as const) {
      const staleCheck = await checkStaleJsonl(p, label);
      if (staleCheck) projectChecks.push(staleCheck);
    }
  }

  printChecks(projectChecks);
  console.log();

  // 4. handoff on PATH
  console.log("## global install");
  const globalChecks: Check[] = [];
  const binPath = await findOnPath("handoff");
  if (!binPath) {
    globalChecks.push({
      level: "warn",
      label: "`handoff` not found on PATH",
      detail: "run `npm install -g @zohartito/handoff` (or `npm link` from the repo root)",
    });
  } else if (!(await exists(binPath))) {
    globalChecks.push({
      level: "warn",
      label: "`handoff` on PATH but points to missing file",
      detail: binPath,
    });
  } else {
    globalChecks.push({ level: "ok", label: `handoff → ${binPath}` });
  }

  // 4b. Stale npm shim pointing at an old package name (e.g. `@handoff/cli`).
  // This is the failure from the 0.7 upgrade: the user had a `handoff.cmd`
  // shim left behind from a previous (differently-named) install, and running
  // it threw MODULE_NOT_FOUND because the target package no longer exists.
  const shimChecks = await checkGlobalShims();
  globalChecks.push(...shimChecks);

  // Note: we intentionally do not network-call the npm registry for a latest-version
  // check here — keeps `handoff doctor` offline-safe. Run `npm outdated -g @zohartito/handoff`
  // manually if you want to know.
  printChecks(globalChecks);
  console.log();

  // 5. Claude Code hooks
  console.log("## claude code hooks");
  const hookChecks = await checkClaudeHooks(cwd);
  // Cross-check: hooks are configured but `handoff` isn't on PATH — they will fail silently.
  const hooksConfigured = hookChecks.some((c) => c.level === "ok" && c.label.includes("hooks installed"));
  if (hooksConfigured && !binPath) {
    hookChecks.push({
      level: "err",
      label: "hooks configured but `handoff` is not on PATH",
      detail: "Claude Code will fail to invoke the hooks — install with `npm install -g @zohartito/handoff`",
    });
    hasError = true;
  }
  printChecks(hookChecks);
  console.log();

  // 6. Git state
  console.log("## git");
  const gitChecks: Check[] = [];
  const git = await collectGitState(cwd);
  if (!git) {
    gitChecks.push({ level: "ok", label: "not a git repo (fine)" });
  } else {
    const branch = git.branch ?? "(detached)";
    const changes = countLines(git.status);
    const clean = changes === 0;
    gitChecks.push({
      level: "ok",
      label: `branch: ${branch}`,
      detail: clean ? "working tree clean" : `${changes} change${changes === 1 ? "" : "s"} uncommitted`,
    });
  }
  printChecks(gitChecks);
  console.log();

  // 7. Staleness — is the artifact drifting behind the code? All checks here
  // are `warn` at most: a doctor that fails CI over a stale doc gets disabled.
  console.log("## staleness");
  const staleChecks = await checkStaleness(cwd, paths, meta, git);
  printChecks(staleChecks);
  console.log();

  // tally
  const allChecks: Check[] = [...projectChecks, ...globalChecks, ...hookChecks, ...gitChecks, ...staleChecks];
  const errs = allChecks.filter((c) => c.level === "err").length;
  const warns = allChecks.filter((c) => c.level === "warn").length;
  const oks = allChecks.filter((c) => c.level === "ok").length;
  console.log(`## summary`);
  console.log(`  ${oks} ok, ${warns} warn, ${errs} err`);

  if (errs > 0 || hasError) {
    process.exitCode = 1;
  }
}

async function checkClaudeHooks(cwd: string): Promise<Check[]> {
  const projectSettings = resolve(cwd, ".claude", "settings.json");
  const globalSettings = resolve(homedir(), ".claude", "settings.json");

  const projectExists = await exists(projectSettings);
  const globalExists = await exists(globalSettings);

  if (!projectExists && !globalExists) {
    return [
      {
        level: "warn",
        label: "no .claude/settings.json found",
        detail: "run `handoff install --tool claude-code` for setup instructions",
      },
    ];
  }

  const checks: Check[] = [];
  for (const [label, path] of [
    ["project (.claude/settings.json)", projectSettings],
    ["global (~/.claude/settings.json)", globalSettings],
  ] as const) {
    if (!(await exists(path))) continue;
    const settings = await readJson<Record<string, unknown>>(path);
    if (!settings) {
      checks.push({ level: "warn", label: `${label} unreadable` });
      continue;
    }
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    const hookChecks: Array<[string, string, string]> = [
      ["SessionStart", "session-start", "primer injection on new session"],
      ["Stop", "stop", "auto-save on session end"],
      ["StopFailure", "rate-limit", "capture rate-limit event"],
    ];
    const present: string[] = [];
    const missing: string[] = [];
    for (const [event, subcmd, _desc] of hookChecks) {
      if (hasHandoffCommand(hooks[event], `handoff hook ${subcmd}`)) {
        present.push(event);
      } else {
        missing.push(event);
      }
    }
    if (missing.length === 0) {
      checks.push({ level: "ok", label: `${label}: all 3 hooks installed` });
    } else if (present.length === 0) {
      checks.push({
        level: "warn",
        label: `${label}: no handoff hooks`,
        detail: "see `handoff install --tool claude-code`",
      });
    } else {
      checks.push({
        level: "warn",
        label: `${label}: ${present.length}/3 hooks (missing: ${missing.join(", ")})`,
      });
    }
  }
  return checks;
}

function hasHandoffCommand(hookEntry: unknown, needle: string): boolean {
  if (!Array.isArray(hookEntry)) return false;
  for (const item of hookEntry) {
    if (!item || typeof item !== "object") continue;
    const inner = (item as Record<string, unknown>).hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (!h || typeof h !== "object") continue;
      const cmd = (h as Record<string, unknown>).command;
      if (typeof cmd === "string" && cmd.includes(needle)) return true;
    }
  }
  return false;
}

async function findOnPath(bin: string): Promise<string | null> {
  const isWin = platform() === "win32";
  try {
    const cmd = isWin ? "where.exe" : "which";
    const { stdout } = await run(cmd, [bin]);
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the global npm bin directory. Returns null if npm isn't installed
 * or the command fails — callers should skip the check in that case.
 *
 * On Windows the shims live in `%APPDATA%\npm\`, on POSIX in
 * `$(npm prefix -g)/bin/`.
 */
async function globalNpmBinDir(): Promise<string | null> {
  const isWin = platform() === "win32";
  if (isWin) {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    const dir = resolve(appData, "npm");
    return (await exists(dir)) ? dir : null;
  }
  try {
    const { stdout } = await run("npm", ["prefix", "-g"]);
    const prefix = stdout.trim();
    if (!prefix) return null;
    return resolve(prefix, "bin");
  } catch {
    return null;
  }
}

/**
 * Return shim file names to inspect on the current platform. On Windows npm
 * writes three shims per bin (`handoff`, `handoff.cmd`, `handoff.ps1`); on
 * POSIX it writes a single symlink (`handoff`).
 */
function shimNames(): string[] {
  return platform() === "win32"
    ? ["handoff", "handoff.cmd", "handoff.ps1"]
    : ["handoff"];
}

/**
 * Scan a shim's content (or the file it resolves to) for a package name.
 * Returns the first non-`@zohartito/handoff` scoped package reference found,
 * or null if the shim looks healthy.
 *
 * npm shims on Windows are small `.cmd` / `.ps1` wrappers that include the
 * path to the target `.mjs` file. On POSIX they're symlinks whose target
 * path embeds the package name. In both cases the package name is plain
 * text inside the referenced path.
 */
export async function inspectShimForWrongPackage(shimPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(shimPath, "utf8");
  } catch {
    // Might be a symlink on POSIX — resolve it instead.
    try {
      const target = await fs.readlink(shimPath);
      content = target;
    } catch {
      return null;
    }
  }
  // Look for scoped package references of the form `@scope/name` or
  // `@scope\name`. Any scoped reference in the shim that isn't our package is
  // suspicious — most commonly this is `@handoff/cli` left over from the
  // pre-rename install. We accept both slash directions because Windows shims
  // (`.cmd` / `.ps1`) use backslashes in their embedded paths.
  const matches = content.match(/@[a-z0-9][a-z0-9._-]*[\\/][a-z0-9][a-z0-9._-]*/gi);
  if (!matches) return null;
  for (const m of matches) {
    // Normalise to forward-slash for comparison against PACKAGE_NAME.
    const normalised = m.replace(/\\/g, "/").toLowerCase();
    if (normalised !== PACKAGE_NAME.toLowerCase()) {
      return normalised;
    }
  }
  return null;
}

/**
 * Check every shim in the global npm bin dir for a reference to a wrong
 * package name. Returns check results only when there's something to say;
 * a clean shim set produces a single "ok" check.
 */
async function checkGlobalShims(): Promise<Check[]> {
  const binDir = await globalNpmBinDir();
  if (!binDir) {
    return [
      {
        level: "ok",
        label: "global npm bin dir not found — skipping shim check",
        detail: "npm not installed, or $APPDATA / `npm prefix -g` unavailable",
      },
    ];
  }
  const stale: Array<{ path: string; wrongPackage: string }> = [];
  const found: string[] = [];
  for (const name of shimNames()) {
    const shimPath = resolve(binDir, name);
    if (!(await exists(shimPath))) continue;
    found.push(shimPath);
    const wrongPackage = await inspectShimForWrongPackage(shimPath);
    if (wrongPackage) stale.push({ path: shimPath, wrongPackage });
  }
  if (found.length === 0) {
    return []; // nothing installed — already covered by the PATH check above
  }
  if (stale.length === 0) {
    return [{ level: "ok", label: `shim targets ${PACKAGE_NAME} (${found.length} file${found.length === 1 ? "" : "s"})` }];
  }
  const paths = stale.map((s) => s.path).join(" ");
  const wrongPkgs = [...new Set(stale.map((s) => s.wrongPackage))].join(", ");
  const rmCmd = platform() === "win32" ? `del ${paths}` : `rm ${paths}`;
  return [
    {
      level: "err",
      label: `stale shim detected (points at ${wrongPkgs})`,
      detail: `remove and reinstall: ${rmCmd} && npm install -g ${PACKAGE_NAME}`,
    },
  ];
}

/**
 * Flag a `.jsonl` file that exists but is empty/near-empty (<=1 byte). These
 * are leftovers from <=0.6 `handoff init`, which pre-created them.
 *
 * Returns null if the file is absent (fine — v0.7 doesn't create it) or if
 * the file has real content (fine — something has logged to it).
 */
async function checkStaleJsonl(
  path: string,
  label: string,
): Promise<Check | null> {
  try {
    const stat = await fs.stat(path);
    if (stat.size > 1) return null; // has real content
    return {
      level: "warn",
      label: `${label} is empty (0-byte leftover from old init)`,
      detail: `delete it (will be recreated by \`handoff capture\` on first write) or run \`handoff capture\``,
    };
  } catch {
    return null; // absent — that's the happy path in 0.7+
  }
}

/**
 * Staleness detection: warn (never err) when the .handoff/ artifact has
 * drifted behind the code. A confidently-wrong artifact is worse than none,
 * because the next agent trusts it and works from a false map.
 *
 * Three checks, all commit-count driven where possible (a time threshold
 * would cry wolf on dormant-but-healthy projects — old timestamp, no new
 * commits, nothing actually wrong):
 *   A. commits landed since last `handoff save`      (>= 10)
 *   C. task.md's newest version ref behind package.json (strictly <)
 *   D. attempts.md / corrections.md went silent      (>= 25, gated on content)
 *
 * Check B (matching open-loops items against things marked shipped elsewhere)
 * was deliberately REJECTED: distinguishing "shipped but validation still
 * open" from "done but wrongly listed open" is semantic, not lexical, and
 * this very repo is the counter-example — open-loops.md legitimately lists an
 * OPEN `ingest --from cursor` real-data validation while ROADMAP.md marks the
 * feature `[x]` shipped. Any lexical matcher would false-positive on it.
 */
async function checkStaleness(
  cwd: string,
  paths: HandoffPaths,
  meta: Meta | null,
  git: Awaited<ReturnType<typeof collectGitState>>,
): Promise<Check[]> {
  const checks: Check[] = [];
  const inRepo = git !== null;

  // --- Check A: commits landed since last save (commit-count, not time) ---
  if (inRepo && meta?.updatedAt) {
    const n = await commitsSince(cwd, meta.updatedAt);
    if (n !== null) {
      if (n >= STALE_COMMIT_THRESHOLD) {
        checks.push({
          level: "warn",
          label: `artifact not saved in the last ${n} commits`,
          detail: `meta.updatedAt is ${meta.updatedAt} — run \`handoff save\` to refresh it`,
        });
      } else {
        checks.push({
          level: "ok",
          label: `artifact saved recently (${n} commit${n === 1 ? "" : "s"} since last save)`,
        });
      }
    }
  }

  // --- Check C: task.md's newest version reference behind package.json ---
  // Skip entirely when there's no package.json / no version field (most
  // non-JS projects). task.md legitimately mentions old versions in prose
  // history, so only "the doc's HIGHEST known version is behind the code"
  // counts as stale.
  const pkg = await readJson<{ version?: unknown }>(resolve(cwd, "package.json"));
  const pkgVersion = pkg && typeof pkg.version === "string" ? pkg.version : null;
  if (pkgVersion && extractVersions(pkgVersion).length > 0) {
    const versions = extractVersions(await readOrEmpty(paths.task));
    if (versions.length > 0) {
      let highest = versions[0];
      for (const v of versions) if (cmpSemver(v, highest) > 0) highest = v;
      if (cmpSemver(highest, pkgVersion) < 0) {
        checks.push({
          level: "warn",
          label: `task.md's newest version reference (${highest}) is behind package.json (${pkgVersion})`,
          detail: "task.md may describe an earlier release — refresh it with `handoff save`",
        });
      } else {
        checks.push({
          level: "ok",
          label: `task.md's newest version reference (${highest}) is current with package.json (${pkgVersion})`,
        });
      }
    }
  }

  // --- Check D: attempts.md / corrections.md went silent ---
  // Gated hard: if the file is still template-only the project never adopted
  // the habit, so silence isn't a regression. Measured per-file.
  if (inRepo) {
    for (const [label, p, cmd] of [
      ["attempts.md", paths.attempts, "handoff attempt"],
      ["corrections.md", paths.corrections, "handoff correct"],
    ] as const) {
      const content = await readOrEmpty(p);
      if (stripTemplate(content).trim().length === 0) continue; // never adopted — skip
      const n = await commitsSincePathChange(cwd, p);
      if (n === null) continue; // never committed — nothing to measure against
      if (n >= STALE_LOG_COMMIT_THRESHOLD) {
        checks.push({
          level: "warn",
          label: `${label} unchanged across the last ${n} commits`,
          detail: `if you've hit dead-ends or been corrected since, log them with \`${cmd}\``,
        });
      } else {
        checks.push({
          level: "ok",
          label: `${label} updated recently (${n} commit${n === 1 ? "" : "s"} ago)`,
        });
      }
    }
  }

  if (checks.length === 0) {
    checks.push({
      level: "ok",
      label: inRepo
        ? "no staleness signals"
        : "not a git repo — commit-based staleness checks skipped",
    });
  }

  return checks;
}

/**
 * Extract every three-part semver-like token (`1.2.3`) from text. The word
 * boundaries keep it from matching dates (`2026-07-31`), test counts
 * (`160/160`), times (`23:38:32`) or two-part versions (`>=22.5`).
 */
export function extractVersions(text: string): string[] {
  return text.match(/\b\d+\.\d+\.\d+\b/g) ?? [];
}

/**
 * Numerically compare two dotted three-part version strings. Returns a
 * negative number if a < b, positive if a > b, 0 if equal. Component-wise
 * numeric comparison so `0.10.0` correctly sorts above `0.9.9`.
 */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10));
  const pb = b.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function printChecks(checks: Check[]): void {
  for (const c of checks) {
    const mark = c.level === "ok" ? "● ok  " : c.level === "warn" ? "○ warn" : "✗ err ";
    const detail = c.detail ? `\n        ${c.detail}` : "";
    console.log(`  ${mark}  ${c.label}${detail}`);
  }
}

function stripTemplate(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").replace(/^#.*$/gm, "").replace(/^##.*$/gm, "");
}

function countLines(s: string): number {
  if (!s.trim()) return 0;
  return s.trim().split("\n").length;
}
