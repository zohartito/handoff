import { createInterface } from "node:readline";
import { resolveHandoffPaths, type HandoffPaths } from "../format/paths.js";
import { exists, readOrEmpty } from "../util/fs.js";
import { buildCompactPrimer, renderOpenLoops, VALID_TOOLS, type Tool } from "../commands/prime.js";
import { correct } from "../commands/correct.js";
import { attempt } from "../commands/attempt.js";
import { decide } from "../commands/decide.js";
import { status } from "../commands/status.js";

/**
 * Hand-rolled MCP (Model Context Protocol) server over stdio.
 *
 * The protocol is JSON-RPC 2.0 with newline-delimited JSON messages on stdin
 * (requests in) / stdout (responses out). We implement it by hand rather than
 * pull in `@modelcontextprotocol/sdk`: handoff's defining property is zero
 * runtime dependencies beyond `commander`, and the method set we need is small
 * — `initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
 * `ping`, and a clean EOF shutdown.
 *
 * Verified against the 2025-06-18 spec (modelcontextprotocol.io):
 * - initialize result carries `protocolVersion`, `capabilities`, `serverInfo`.
 * - Version negotiation: echo the client's version if we support it, else
 *   answer with our latest supported version (the client then decides).
 * - `notifications/initialized` is a notification (no id) → no response.
 * - tools/list result: `{ tools: [{ name, title?, description, inputSchema }] }`.
 * - tools/call params `{ name, arguments }` → `{ content: [{type,text}], isError? }`.
 * - stdio shutdown has no message: the client closes stdin; we exit on EOF.
 *
 * CRITICAL: stdout is the JSON-RPC channel. Nothing else may ever write to it,
 * or the message stream corrupts. The reused command implementations
 * (`correct`, `decide`, `status`, ...) `console.log`, so on startup we redirect
 * `console.log` → `console.error` for the whole server lifetime. Every
 * protocol write goes through `writeMessage`, which is the only path to stdout.
 */

// Protocol versions we speak, newest first. We answer `initialize` with the
// client's version when it's one of these, otherwise with SUPPORTED[0].
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Standard JSON-RPC 2.0 error codes (+ the MCP-relevant subset).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type ToolContext = {
  projectRoot: string;
  paths: HandoffPaths;
};

type ToolResult = { text: string; isError?: boolean };

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

export type McpServerOpts = {
  /** Project root the server operates on. */
  cwd: string;
  /** Server version reported in `serverInfo` (the handoff package version). */
  version: string;
};

// ------------- tool definitions -------------

/**
 * The six tools an MCP client sees. Names + descriptions are the atom the model
 * reasons over, so they're written to be self-explanatory without the README.
 */
export const TOOLS: ToolDef[] = [
  {
    name: "handoff_context",
    description:
      "Return the current project's handoff state as a compact primer: the task, " +
      "open loops, standing corrections, and recent failed attempts reconstructed " +
      "from prior sessions. Read this first when resuming work you did not start. " +
      "Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          enum: [...VALID_TOOLS],
          description:
            "Which agent the primer is tailored for (tool-name hints for its edit/shell verbs). Defaults to 'generic'.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const tool = (args.tool as Tool) ?? "generic";
      const text = await buildCompactPrimer(ctx.paths, tool);
      return { text };
    },
  },
  {
    name: "handoff_open_loops",
    description:
      "List the project's unfinished work — open questions, blocked items, and " +
      "next steps recorded in .handoff/open-loops.md. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const cleaned = renderOpenLoops(await readOrEmpty(ctx.paths.openLoops));
      return {
        text: cleaned || "No open loops are recorded in .handoff/open-loops.md.",
      };
    },
  },
  {
    name: "handoff_log_correction",
    description:
      "Record that the user corrected the agent — the highest-signal input for " +
      "future sessions. Persisted to .handoff/corrections.md and promoted to a " +
      "standing rule if it recurs.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "What the agent did that was wrong.",
        },
        userSaid: {
          type: "string",
          description: "The user's correction, verbatim.",
        },
        lesson: {
          type: "string",
          description: "Optional: the extracted rule to follow next time.",
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Optional: evidence files relative to the repository root, hashed when logged. Must exist and stay inside the repository.",
        },
        key: {
          type: "string",
          description:
            "Optional: stable fact key (e.g. 'deploy.target'). A newer entry " +
            "with the same key revokes the older one; revoked entries stay in " +
            "the file for audit.",
        },
      },
      required: ["action", "userSaid"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const guard = await requireHandoff(ctx);
      if (guard) return guard;
      await correct({
        action: String(args.action),
        userSaid: String(args.userSaid),
        lesson: args.lesson === undefined ? undefined : String(args.lesson),
        evidence: evidencePaths(args.evidence),
        key: args.key === undefined ? undefined : String(args.key),
        cwd: ctx.projectRoot,
        quiet: true,
      });
      return { text: "Logged correction to .handoff/corrections.md." };
    },
  },
  {
    name: "handoff_log_attempt",
    description:
      "Record a failed approach so no future session repeats it. Persisted to " +
      ".handoff/attempts.md.",
    inputSchema: {
      type: "object",
      properties: {
        what: {
          type: "string",
          description: "The approach that was tried and failed.",
        },
        error: {
          type: "string",
          description: "Optional: the verbatim error output it produced.",
        },
        fix: {
          type: "string",
          description: "Optional: what ended up working instead.",
        },
      },
      required: ["what"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const guard = await requireHandoff(ctx);
      if (guard) return guard;
      await attempt({
        what: String(args.what),
        error: args.error === undefined ? undefined : String(args.error),
        fix: args.fix === undefined ? undefined : String(args.fix),
        cwd: ctx.projectRoot,
        quiet: true,
      });
      return { text: "Logged failed attempt to .handoff/attempts.md." };
    },
  },
  {
    name: "handoff_log_decision",
    description:
      "Record a decision and its reasoning so the next session understands why " +
      "the project is the way it is. Persisted to .handoff/decisions.md.",
    inputSchema: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          description: "The decision that was made.",
        },
        because: {
          type: "string",
          description: "Optional: the reasoning behind it.",
        },
        alternatives: {
          type: "array",
          items: { type: "string" },
          description: "Optional: the alternatives that were considered and rejected.",
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Optional: evidence files relative to the repository root, hashed when logged. Must exist and stay inside the repository.",
        },
        key: {
          type: "string",
          description:
            "Optional: stable fact key (e.g. 'deploy.target'). A newer entry " +
            "with the same key revokes the older one; revoked entries stay in " +
            "the file for audit.",
        },
      },
      required: ["choice"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const guard = await requireHandoff(ctx);
      if (guard) return guard;
      await decide({
        choice: String(args.choice),
        because: args.because === undefined ? undefined : String(args.because),
        alternatives: normalizeStringArray(args.alternatives),
        evidence: evidencePaths(args.evidence),
        key: args.key === undefined ? undefined : String(args.key),
        cwd: ctx.projectRoot,
      });
      return { text: "Logged decision to .handoff/decisions.md." };
    },
  },
  {
    name: "handoff_status",
    description:
      "Report which .handoff/ files are populated vs still template, with sizes " +
      "and snapshot timestamps — a staleness signal for the reconstructed state. " +
      "Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => {
      const guard = await requireHandoff(ctx);
      if (guard) return guard;
      const lines = await captureConsoleLog(() => status({ cwd: ctx.projectRoot }));
      return { text: lines.join("\n") };
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ------------- dispatch -------------

/**
 * Handle one parsed JSON-RPC message. Returns the response object to write, or
 * `null` for notifications (which get no response). Pure enough to unit-test;
 * the loop below owns the transport.
 */
export async function dispatch(
  msg: JsonRpcRequest,
  ctx: ToolContext,
  version: string,
): Promise<Record<string, unknown> | null> {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    const id =
      msg && typeof msg === "object" && (typeof msg.id === "string" || typeof msg.id === "number")
        ? msg.id
        : null;
    return errorResponse(id, INVALID_REQUEST, "Invalid JSON-RPC request.");
  }

  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize":
      return result(msg.id ?? null, initializeResult(msg.params, version));

    case "notifications/initialized":
      // Notification: no response.
      return null;

    case "ping":
      // Spec utility: respond with an empty result.
      return isNotification ? null : result(msg.id ?? null, {});

    case "tools/list":
      return result(msg.id ?? null, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call":
      return toolsCall(msg, ctx);

    default:
      if (isNotification) return null; // ignore unknown notifications
      return errorResponse(
        msg.id ?? null,
        METHOD_NOT_FOUND,
        `Method not found: ${msg.method}`,
      );
  }
}

function initializeResult(params: unknown, version: string): Record<string, unknown> {
  const requested =
    params && typeof params === "object"
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  const protocolVersion =
    typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSIONS[0];

  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "handoff", version },
    instructions:
      "handoff exposes the current project's portable session state. Call " +
      "handoff_context first to load the task and prior corrections, and use the " +
      "handoff_log_* tools to record corrections, failed attempts, and decisions " +
      "so they survive to the next session.",
  };
}

async function toolsCall(
  msg: JsonRpcRequest,
  ctx: ToolContext,
): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };

  if (typeof params.name !== "string") {
    return errorResponse(id, INVALID_PARAMS, "tools/call requires a string 'name'.");
  }
  const tool = TOOLS_BY_NAME.get(params.name);
  if (!tool) {
    return errorResponse(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
  }

  const args =
    params.arguments && typeof params.arguments === "object"
      ? (params.arguments as Record<string, unknown>)
      : {};

  const missing = missingRequired(tool.inputSchema, args);
  if (missing) {
    return errorResponse(
      id,
      INVALID_PARAMS,
      `Missing required parameter '${missing}' for ${tool.name}.`,
    );
  }

  try {
    const out = await tool.handler(args, ctx);
    return result(id, {
      content: [{ type: "text", text: out.text }],
      isError: out.isError ?? false,
    });
  } catch (err) {
    // A handler throwing is a tool-execution error, reported in-band via
    // isError (per spec) rather than as a protocol error, so the model can see
    // and react to it.
    const text = err instanceof Error ? err.message : String(err);
    return result(id, {
      content: [{ type: "text", text: `Tool ${tool.name} failed: ${text}` }],
      isError: true,
    });
  }
}

// ------------- server loop -------------

/**
 * Start the stdio server. Resolves when the client closes stdin (EOF), which
 * is how the stdio transport signals shutdown.
 */
export function runMcpServer(opts: McpServerOpts): Promise<void> {
  // Guarantee stdout stays a pure JSON-RPC channel: reused commands log with
  // console.log, so route it (and console.info) to stderr for the whole run.
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);

  const ctx: ToolContext = {
    projectRoot: opts.cwd,
    paths: resolveHandoffPaths(opts.cwd),
  };

  return new Promise<void>((resolve) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

    // Serialize line handling so responses are written in receive order and
    // never interleave on stdout.
    let chain: Promise<void> = Promise.resolve();

    rl.on("line", (line) => {
      chain = chain.then(() => handleLine(line, ctx, opts.version));
    });

    rl.on("close", () => {
      // stdin EOF → drain in-flight work, then resolve (clean shutdown).
      chain.then(() => resolve());
    });
  });
}

async function handleLine(line: string, ctx: ToolContext, version: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return; // ignore blank keep-alive lines

  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    // Malformed JSON must not kill the server — answer with a parse error.
    writeMessage(errorResponse(null, PARSE_ERROR, "Parse error: invalid JSON."));
    return;
  }

  try {
    const response = await dispatch(msg, ctx, version);
    if (response) writeMessage(response);
  } catch (err) {
    const id =
      msg && typeof msg === "object" && (typeof msg.id === "string" || typeof msg.id === "number")
        ? msg.id
        : null;
    const text = err instanceof Error ? err.message : String(err);
    writeMessage(errorResponse(id, INTERNAL_ERROR, `Internal error: ${text}`));
  }
}

// ------------- helpers -------------

/** The only path to stdout: one JSON message per line. */
function writeMessage(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function result(id: JsonRpcId, res: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: res };
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Return the name of the first required schema property missing from args. */
function missingRequired(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    const v = args[key];
    if (v === undefined || v === null || v === "") return key;
  }
  return null;
}

/** `.handoff/` must exist before any write tool runs. */
async function requireHandoff(ctx: ToolContext): Promise<ToolResult | null> {
  if (await exists(ctx.paths.dir)) return null;
  return {
    text:
      `.handoff/ not found in ${ctx.projectRoot}. ` +
      "Run `handoff init` in the project first.",
    isError: true,
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => String(v)).filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;
}

function evidencePaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) {
    throw new Error("evidence must be an array of file paths.");
  }
  return value;
}

/**
 * Run `fn` while capturing everything it writes via console.log, returning the
 * captured lines. Used by handoff_status, which reuses the CLI `status()`
 * implementation (it prints with console.log). Restores console.log after.
 */
async function captureConsoleLog(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  const prevExit = process.exitCode;
  try {
    await fn();
  } finally {
    console.log = original;
    process.exitCode = prevExit;
  }
  return lines;
}
