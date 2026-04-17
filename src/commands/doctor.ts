import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { resolveHandoffPaths } from "../format/paths.js";
import { exists, readJson, readOrEmpty } from "../util/fs.js";
import { collectGitState } from "../util/git.js";
import { SCHEMA_VERSION } from "../format/types.js";
import { loadMeta } from "../format/migrate.js";

const run = promisify(execFile);

type Level = "ok" | "warn" | "err";
type Check = { level: Level; label: string; detail?: string };

export async function doctor(opts: { cwd?: string } = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const paths = resolveHandoffPaths(cwd);

  let hasError = false;

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
    const meta = await loadMeta(paths.meta);
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

  // tally
  const allChecks: Check[] = [...projectChecks, ...globalChecks, ...hookChecks, ...gitChecks];
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
