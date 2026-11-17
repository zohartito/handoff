import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePrompt } from "../src/commands/asks.js";
import { resolveHandoffPaths } from "../src/format/paths.js";

/**
 * These tests drive the MCP server the way a real client does: spawn it as a
 * subprocess and exchange newline-delimited JSON-RPC over stdio. The compiled
 * entry point lives next to this test file's compiled output.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

/** A minimal populated `.handoff/` so read + write tools have something real. */
function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-mcp-"));
  mkdirSync(join(dir, ".handoff"), { recursive: true });
  const paths = resolveHandoffPaths(dir);
  writeFileSync(
    paths.meta,
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceTool: "claude-code",
        sourceVersion: null,
        createdAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T12:00:00Z",
        projectRoot: dir,
      },
      null,
      2,
    ),
  );
  writeFileSync(paths.task, "# Task\n\n## Goal\n\nBuild the MCP server for handoff.\n");
  writeFileSync(
    paths.openLoops,
    "# Open Loops\n\n- Decide the exact protocolVersion to advertise\n- Wire the `mcp` subcommand\n",
  );
  writeFileSync(paths.corrections, "# Corrections\n");
  writeFileSync(paths.attempts, "# Attempts\n");
  writeFileSync(paths.decisions, "# Decisions\n");
  return dir;
}

/** Tiny JSON-RPC-over-stdio client for the spawned server. */
class Client {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  /** Every raw line the server emitted on stdout (for conformance assertions). */
  readonly stdoutLines: string[] = [];
  stderr = "";
  private exited: Promise<number> | null = null;

  constructor(cwd: string) {
    this.child = spawn(process.execPath, [CLI, "mcp", "--cwd", cwd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      this.stdoutLines.push(line);
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // conformance test inspects stdoutLines directly
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    }
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(payload + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  writeRaw(raw: string): void {
    this.child.stdin.write(raw);
  }

  close(): Promise<number> {
    // Idempotent: repeated calls (try + finally) await the same exit.
    if (!this.exited) {
      this.exited = new Promise((resolve) => {
        if (this.child.exitCode !== null) return resolve(this.child.exitCode);
        this.child.on("exit", (code) => resolve(code ?? 0));
      });
      this.child.stdin.end();
    }
    return this.exited;
  }
}

test("initialize returns protocolVersion, tools capability, and serverInfo", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    const res = await c.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(res.jsonrpc, "2.0");
    assert.equal(res.error, undefined);
    assert.equal(res.result.protocolVersion, "2025-06-18");
    assert.ok(res.result.capabilities.tools, "advertises a tools capability");
    assert.equal(res.result.serverInfo.name, "handoff");
    assert.equal(typeof res.result.serverInfo.version, "string");
    // A supported-but-older version is echoed back verbatim.
    const older = await c.request("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(older.result.protocolVersion, "2024-11-05");
    // An unknown version falls back to our latest.
    const unknown = await c.request("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(unknown.result.protocolVersion, "2025-06-18");
  } finally {
    await c.close();
  }
});

test("tools/list returns all six tools with valid object schemas", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    await c.request("initialize", {});
    c.notify("notifications/initialized");
    const res = await c.request("tools/list");
    const tools = res.result.tools as Array<any>;
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "handoff_context",
      "handoff_log_attempt",
      "handoff_log_correction",
      "handoff_log_decision",
      "handoff_open_loops",
      "handoff_status",
    ]);
    for (const t of tools) {
      assert.equal(typeof t.description, "string");
      assert.ok(t.description.length > 0, `${t.name} has a description`);
      assert.equal(t.inputSchema.type, "object", `${t.name} schema is an object`);
      assert.ok(t.inputSchema.properties, `${t.name} schema has properties`);
    }
  } finally {
    await c.close();
  }
});

test("tools/call handoff_context returns primer text content", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    await c.request("initialize", {});
    const res = await c.request("tools/call", { name: "handoff_context", arguments: {} });
    assert.equal(res.result.isError, false);
    assert.equal(res.result.content[0].type, "text");
    assert.match(res.result.content[0].text, /HANDOFF PRIMER/);
    assert.match(res.result.content[0].text, /Build the MCP server/);
  } finally {
    await c.close();
  }
});

test("tools/call handoff_open_loops returns the open loops", async () => {
  const cwd = scaffold();
  await capturePrompt(resolveHandoffPaths(cwd), "Also keep <!-- prototype --> verbatim.", "s", true);
  const c = new Client(cwd);
  try {
    await c.request("initialize", {});
    const res = await c.request("tools/call", { name: "handoff_open_loops", arguments: {} });
    assert.equal(res.result.isError, false);
    assert.match(res.result.content[0].text, /protocolVersion to advertise/);
    assert.match(res.result.content[0].text, /Also keep <!-- prototype --> verbatim/);
  } finally {
    await c.close();
  }
});

test("tools/call handoff_log_correction actually mutates corrections.md", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    await c.request("initialize", {});
    const res = await c.request("tools/call", {
      name: "handoff_log_correction",
      arguments: {
        action: "wrote a README unprompted",
        userSaid: "don't generate markdown you weren't asked for",
        lesson: "only create docs when explicitly requested",
      },
    });
    assert.equal(res.result.isError, false);
    const written = readFileSync(resolveHandoffPaths(cwd).corrections, "utf8");
    assert.match(written, /wrote a README unprompted/);
    assert.match(written, /don't generate markdown you weren't asked for/);
    assert.match(written, /only create docs when explicitly requested/);
  } finally {
    await c.close();
  }
});

test("tools/call handoff_log_decision + handoff_log_attempt mutate their files", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    await c.request("initialize", {});
    await c.request("tools/call", {
      name: "handoff_log_decision",
      arguments: {
        choice: "implement MCP by hand, no SDK",
        because: "zero-dependency is a defining property",
        alternatives: ["@modelcontextprotocol/sdk"],
      },
    });
    await c.request("tools/call", {
      name: "handoff_log_attempt",
      arguments: { what: "used the SDK", error: "adds a dependency", fix: "hand-rolled JSON-RPC" },
    });
    const paths = resolveHandoffPaths(cwd);
    assert.match(readFileSync(paths.decisions, "utf8"), /implement MCP by hand, no SDK/);
    assert.match(readFileSync(paths.decisions, "utf8"), /@modelcontextprotocol\/sdk/);
    assert.match(readFileSync(paths.attempts, "utf8"), /used the SDK/);
  } finally {
    await c.close();
  }
});

test("missing required params returns an invalid-params JSON-RPC error", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    await c.request("initialize", {});
    const res = await c.request("tools/call", {
      name: "handoff_log_correction",
      arguments: { action: "did a thing" }, // userSaid missing
    });
    assert.equal(res.result, undefined);
    assert.equal(res.error.code, -32602);
    assert.match(res.error.message, /userSaid/);
  } finally {
    await c.close();
  }
});

test("unknown method returns a method-not-found error object, not a crash", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    await c.request("initialize", {});
    const res = await c.request("no/such/method");
    assert.equal(res.result, undefined);
    assert.equal(res.error.code, -32601);
    assert.match(res.error.message, /Method not found/);
    // Server is still alive and answering afterward.
    const list = await c.request("tools/list");
    assert.ok(Array.isArray(list.result.tools));
  } finally {
    await c.close();
  }
});

test("a malformed JSON line does not kill the server", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    c.writeRaw("this is not json\n");
    c.writeRaw("{ broken json\n");
    // Server survived and still responds.
    const res = await c.request("initialize", {});
    assert.equal(res.result.serverInfo.name, "handoff");
  } finally {
    await c.close();
  }
});

test("stdout carries ONLY valid JSON-RPC — no stray log output leaks in", async () => {
  const cwd = scaffold();
  const c = new Client(cwd);
  try {
    await c.request("initialize", {});
    c.notify("notifications/initialized");
    // Exercise a write tool + status: these reuse commands that console.log on
    // success. If the redirect fails, their output would corrupt stdout.
    await c.request("tools/call", {
      name: "handoff_log_correction",
      arguments: { action: "x", userSaid: "y" },
    });
    await c.request("tools/call", { name: "handoff_status", arguments: {} });
    await c.request("tools/list");
    await c.close();

    assert.ok(c.stdoutLines.length > 0, "server produced output");
    for (const line of c.stdoutLines) {
      let parsed: any;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(line);
      }, `stdout line is not valid JSON: ${JSON.stringify(line)}`);
      assert.equal(parsed.jsonrpc, "2.0", `stdout line is not JSON-RPC: ${line}`);
    }
  } finally {
    // close() already called above; calling again is harmless.
    await c.close();
  }
});
