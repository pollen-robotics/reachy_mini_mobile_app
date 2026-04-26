/**
 * Token / secret redaction for structured log payloads.
 *
 * Goal: keep logs useful enough to correlate values (same token across
 * lines, same auth header on a sequence of requests) without leaking
 * the full secret.
 *
 * Strategy: walk the kv payload, when the *key* matches a sensitive
 * pattern and the value is a string, replace it with a short fingerprint
 * (first 4 + last 4 chars). Non-string values are kept as-is, since
 * ints/booleans for sensitive keys are nonsense and unlikely.
 *
 * HF tokens look like `hf_AbCd…WxYz` (typically 36+ chars), so keeping
 * 4+4 is enough to dedupe two distinct tokens visually. For very short
 * values we just emit `REDACTED` to avoid printing the whole thing.
 */

const SENSITIVE_KEY_RE =
  /^(token|hf_token|hftoken|access_token|refresh_token|authorization|bearer|password|secret|api_?key)$/i;

export function redactToken(value: string): string {
  if (!value) return value;
  if (value.length <= 12) return 'REDACTED';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function redactObject(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (depth > 6) return '[truncated]';
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((v) => redactObject(v, depth + 1));
  }
  if (typeof input !== 'object') return input;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key) && typeof value === 'string') {
      out[key] = redactToken(value);
    } else {
      out[key] = redactObject(value, depth + 1);
    }
  }
  return out;
}
