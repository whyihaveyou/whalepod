/**
 * Shared helpers for parsing agent NDJSON/JSON output lines.
 *
 * External CLI agents emit machine-readable output either as newline-delimited
 * JSON (NDJSON) or as a single JSON document, plus stray non-JSON banner lines.
 * These helpers make the per-adapter normalizers tolerant of both.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

/** Best-effort JSON parse that never throws and tolerates leading `data:` prefixes. */
export function tryParseJson<T = Record<string, unknown>>(line: string): T | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  for (const candidate of [trimmed, trimmed.replace(/^data:\s*/, '')]) {
    if (!candidate) continue
    if (candidate[0] !== '{' && candidate[0] !== '[') continue
    try {
      return JSON.parse(candidate) as T
    } catch {
      // fall through to next candidate
    }
  }
  return null
}

/** Stable tool id fallback when an agent event omits one. */
export function toolSessionId(prefix: string, i: number): string {
  return `${prefix}-${Date.now().toString(36)}-${i}`
}
