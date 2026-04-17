import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

export async function writeFileSafe(path: string, contents: string): Promise<void> {
  await ensureDir(dirname(path));
  await fs.writeFile(path, contents, "utf8");
}

export async function readOrEmpty(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function appendLine(path: string, line: string): Promise<void> {
  await ensureDir(dirname(path));
  const payload = line.endsWith("\n") ? line : line + "\n";
  await fs.appendFile(path, payload, "utf8");
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileSafe(path, JSON.stringify(value, null, 2) + "\n");
}
