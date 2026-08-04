/**
 * Render attacker-controlled repository/session material only as bounded data.
 * JSON escaping plus escaped fence delimiters means an evidence value cannot
 * terminate the surrounding structural channel.
 */
export function serializeUntrustedEvidence(
  source: string,
  value: unknown,
  maxChars: number,
): string {
  const payload = (typeof value === "string"
    ? boundedText(value, Math.max(0, maxChars))
    : boundedJson(value, Math.max(0, maxChars))
  ).replace(/~/g, "\\u007e");
  return `~~~~handoff-evidence\ntrust: untrusted\nsource: ${source}\npayload:\n${payload}\n~~~~`;
}

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n[truncated untrusted evidence]";
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

/** Serialize unknown, nested, or cyclic data without permitting unbounded output. */
function boundedJson(value: unknown, maxChars: number): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, candidate: unknown): unknown => {
    if (typeof candidate === "bigint") return `${candidate}n`;
    if (typeof candidate === "function" || typeof candidate === "symbol") return `[${typeof candidate}]`;
    if (candidate && typeof candidate === "object") {
      if (seen.has(candidate)) return "[circular]";
      seen.add(candidate);
    }
    return candidate;
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(value, replacer) ?? "null";
  } catch {
    serialized = "[unserializable untrusted evidence]";
  }
  // JSON.stringify has no native depth/budget limiter. The final truncation is
  // still deterministic and occurs before the structural evidence fence.
  if (serialized.length <= maxChars) return serialized;
  const marker = "[truncated untrusted evidence]";
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${serialized.slice(0, maxChars - marker.length)}${marker}`;
}
