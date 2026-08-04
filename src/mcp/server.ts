import { frozenFeatureError } from "../frozen.js";

/** A tombstone type retained for source compatibility; no MCP transport is opened. */
export type McpServerOpts = { cwd?: string };
export type ToolDef = Readonly<Record<string, never>>;

/** No tools are advertised in the frozen release. */
export const TOOLS: readonly ToolDef[] = Object.freeze([]);

/** Refuse direct dispatch imports before examining any requested tool or path. */
export async function dispatch(_method?: unknown, _params?: unknown): Promise<never> {
  throw frozenFeatureError("handoff MCP dispatch");
}

/** Refuse direct server startup imports before attaching stdin/stdout or reading state. */
export async function runMcpServer(_opts: McpServerOpts = {}): Promise<never> {
  throw frozenFeatureError("handoff MCP server");
}
