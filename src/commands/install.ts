import { frozenFeatureError } from "../frozen.js";

/** Compatibility tombstone for callers that previously imported install(). */
export async function install(_opts: { tool: string }): Promise<never> {
  throw frozenFeatureError("handoff install");
}
