/** Scrub common credential forms before automatic transcript-derived persistence. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/(\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [REDACTED]")
    .replace(/(\b[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL)[A-Z0-9_-]*\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, "$1[REDACTED]")
    .replace(/(\bhttps?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
