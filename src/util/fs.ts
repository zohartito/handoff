import { constants, promises as fs } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

/**
 * `.handoff` is repository-controlled state that is often rendered into an
 * agent context.  Do not let a repository turn a state read or write into an
 * arbitrary-file operation with a symlink.  The helpers below canonicalise the
 * project root, reject links/non-regular files, and use O_NOFOLLOW for the
 * descriptor that is actually read or written.
 */
type StateLocation = { stateDir: string; target: string };

function stateLocation(path: string): StateLocation | null {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  const marker = segments.indexOf(".handoff");
  if (marker < 0) return null;
  const projectRoot = join(parsed.root, ...segments.slice(0, marker));
  return { stateDir: join(projectRoot, ".handoff"), target: absolute };
}

async function confinedStateLocation(path: string, createStateDir = false): Promise<StateLocation | null> {
  const location = stateLocation(path);
  if (!location) return null;
  const projectRoot = dirname(location.stateDir);
  const canonicalRoot = await fs.realpath(projectRoot);
  const stateDir = join(canonicalRoot, ".handoff");
  const requested = location.target.slice(location.stateDir.length).replace(/^[/\\]+/, "");
  const target = join(stateDir, requested);
  if (relative(stateDir, target).startsWith("..") || relative(stateDir, target) === "") {
    if (target !== stateDir) throw new Error("handoff state path escapes the project");
  }

  try {
    const stateStat = await fs.lstat(stateDir);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
      throw new Error("refusing linked or non-directory .handoff state root");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !createStateDir) throw err;
    await fs.mkdir(stateDir, { recursive: false });
    const created = await fs.lstat(stateDir);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("refusing linked or non-directory .handoff state root");
    }
  }

  // State files are flat today, but validating every existing parent keeps the
  // invariant true if a future state path gains a subdirectory.
  const parent = dirname(target);
  const relParent = relative(stateDir, parent);
  if (relParent && !relParent.startsWith("..")) {
    const parentStat = await fs.lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error("refusing linked handoff state parent");
    }
  }
  return { stateDir, target };
}

async function existingRegular(path: string): Promise<boolean> {
  try {
    const st = await fs.lstat(path);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("refusing linked or non-regular handoff state file");
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function secureRead(location: StateLocation): Promise<string> {
  await existingRegular(location.target);
  const handle = await fs.open(location.target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error("refusing non-regular handoff state file");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function secureWrite(location: StateLocation, contents: string): Promise<void> {
  await existingRegular(location.target);
  const before = await fs.stat(location.stateDir);
  const temp = join(
    location.stateDir,
    `.handoff-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const after = await fs.stat(location.stateDir);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("handoff state root changed during write");
    }
    await fs.rename(temp, location.target);
  } finally {
    if (handle) await handle.close();
    try { await fs.unlink(temp); } catch { /* renamed or never created */ }
  }
}

async function confinedRootLocation(root: string, path: string, createParents = false): Promise<StateLocation> {
  const requestedRoot = resolve(root);
  const canonicalRoot = await fs.realpath(requestedRoot);
  const rel = relative(requestedRoot, resolve(path));
  if (rel === "" || rel.startsWith("..") || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error("path escapes its configured root");
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let parent = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try {
      const st = await fs.lstat(parent);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("refusing linked output parent");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !createParents) throw err;
      await fs.mkdir(parent);
    }
  }
  const target = join(canonicalRoot, rel);
  return { stateDir: dirname(target), target };
}

/** Write within a caller-selected root without following linked parents/files. */
export async function writeFileConfined(root: string, path: string, contents: string): Promise<void> {
  const location = await confinedRootLocation(root, path, true);
  await secureWrite(location, contents);
}

/** Read a regular file beneath a caller-selected root without link traversal. */
export async function readFileConfined(root: string, path: string): Promise<string> {
  const location = await confinedRootLocation(root, path);
  return await secureRead(location);
}

/** Create a directory beneath a caller-selected root only through real directories. */
export async function ensureDirConfined(root: string, path: string): Promise<void> {
  const requestedRoot = resolve(root);
  const canonicalRoot = await fs.realpath(requestedRoot);
  const rel = relative(requestedRoot, resolve(path));
  if (rel === "" || rel.startsWith("..") || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error("directory escapes its configured root");
  }
  let current = canonicalRoot;
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("refusing linked output directory");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await fs.mkdir(current);
    }
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    const location = await confinedStateLocation(path);
    if (location) {
      if (location.target === location.stateDir) return true;
      return await existingRegular(location.target);
    }
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  const location = stateLocation(path);
  if (!location) {
    await fs.mkdir(path, { recursive: true });
    return;
  }
  const confined = await confinedStateLocation(path, true);
  if (!confined || confined.target !== confined.stateDir) {
    throw new Error("handoff state directories must be created at the state root");
  }
}

export async function writeFileSafe(path: string, contents: string): Promise<void> {
  const location = await confinedStateLocation(path, true);
  if (location) {
    await secureWrite(location, contents);
    return;
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, contents, "utf8");
}

export async function readOrEmpty(path: string): Promise<string> {
  try {
    const location = await confinedStateLocation(path);
    return location ? await secureRead(location) : await fs.readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function appendLine(path: string, line: string): Promise<void> {
  const payload = line.endsWith("\n") ? line : line + "\n";
  const location = await confinedStateLocation(path, true);
  if (location) {
    const existing = (await existingRegular(location.target)) ? await secureRead(location) : "";
    await secureWrite(location, existing + payload);
    return;
  }
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, payload, "utf8");
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readOrEmpty(path)) as T;
  } catch {
    return null;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileSafe(path, JSON.stringify(value, null, 2) + "\n");
}
