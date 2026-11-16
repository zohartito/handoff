import { constants, promises as fs } from "node:fs";
import { dirname, resolve, sep, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export class UnsafeStatePathError extends Error {}

/** State is repo-owned data, never a route to files outside the project. */
export async function assertSafeStatePath(path: string): Promise<boolean> {
  const absolute = resolve(path);
  const segments = absolute.split(sep);
  const index = segments.indexOf(".handoff");
  if (index < 0) return false; // explicit input/output paths are caller-selected
  const root = segments.slice(0, index).join(sep) || sep;
  const realRoot = await fs.realpath(root);
  let current = root;
  for (const segment of segments.slice(index)) {
    current = resolve(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafeStatePathError("unsafe handoff state: symlink traversal refused");
    }
    const rel = relative(realRoot, await fs.realpath(current));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) {
      throw new UnsafeStatePathError("unsafe handoff state: path escapes the project");
    }
  }
  return true;
}

export async function exists(path: string): Promise<boolean> {
  await assertSafeStatePath(path);
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await assertSafeStatePath(path);
  await fs.mkdir(path, { recursive: true });
  await assertSafeStatePath(path);
}

export async function writeFileSafe(path: string, contents: string): Promise<void> {
  const state = await assertSafeStatePath(path);
  await ensureDir(dirname(path));
  if (!state) {
    await fs.writeFile(path, contents, "utf8");
    return;
  }
  // Exclusive temporary file + rename: readers see either complete version;
  // a target symlink is never opened for writing.
  const temporary = path + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await assertSafeStatePath(temporary);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    await assertSafeStatePath(path);
    await fs.rename(temporary, path);
  } finally {
    await handle.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function readOrEmpty(path: string): Promise<string> {
  const state = await assertSafeStatePath(path);
  try {
    if (!state) return await fs.readFile(path, "utf8");
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await assertSafeStatePath(path);
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  } catch (err) {
    if (err instanceof UnsafeStatePathError || (err as NodeJS.ErrnoException).code === "ELOOP") throw err;
    return "";
  }
}

export async function appendLine(path: string, line: string): Promise<void> {
  const state = await assertSafeStatePath(path);
  await ensureDir(dirname(path));
  const payload = line.endsWith("\n") ? line : line + "\n";
  const handle = await fs.open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (state ? constants.O_NOFOLLOW : 0), 0o600);
  try {
    await assertSafeStatePath(path);
    await handle.writeFile(payload, "utf8");
  } finally { await handle.close(); }
}

export async function readJson<T>(path: string): Promise<T | null> {
  const raw = await readOrEmpty(path);
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileSafe(path, JSON.stringify(value, null, 2) + "\n");
}
