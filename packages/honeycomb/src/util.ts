/**
 * Shared utilities for `@whalepod/honeycomb`.
 *
 * These were historically exported from the (now removed) `framework.ts`
 * Context shim. They are plain helpers — not Cordis primitives — so on the
 * cordis migration they move here so importing files do not depend on a
 * deleted module.
 *
 * @module @whalepod/honeycomb/util
 */

let counter = 0

/** Monotonic, collision-resistant id (no platform dependency). */
export function makeId(prefix: string): string {
  counter += 1
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${counter.toString(36)}_${rand}`
}

/** Current epoch milliseconds. */
export function now(): number {
  return Date.now()
}
