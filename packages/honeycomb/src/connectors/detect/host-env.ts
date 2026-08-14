/**
 * Host-environment collection.
 *
 * Snapshots the parts of the host the detection layers care about: platform,
 * architecture, home directory, PATH resolution order, and the raw
 * environment (later filtered for subprocess inheritance by the bridge).
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

import { statSync } from 'node:fs'
import type { HostEnvironment } from '../types.ts'

/** Default PATH delimiter per platform. */
const PATH_DELIMITER = process.platform === 'win32' ? ';' : ':'

/**
 * Collect a {@link HostEnvironment} snapshot.
 *
 * @param env - environment source, defaulting to `process.env`.
 * @returns a detached snapshot usable by the detection layers.
 */
export function collectHostEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): HostEnvironment {
  const path = env.PATH ?? ''
  return {
    platform: process.platform,
    arch: process.arch,
    home: env.HOME ?? env.USERPROFILE ?? '',
    pathEntries: path
      .split(PATH_DELIMITER)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    env: { ...env } as Record<string, string>,
  }
}

/**
 * Resolve a binary name against the host PATH.
 *
 * @param binary - executable name, e.g. `claude` or `codex`.
 * @param host - host snapshot (from {@link collectHostEnvironment}).
 * @returns the first existing candidate path, or `undefined` when absent.
 */
export function resolveBinary(binary: string, host: HostEnvironment): string | undefined {
  const extensions = host.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of host.pathEntries) {
    for (const ext of extensions) {
      const candidate = `${dir}/${binary}${ext}`
      if (binaryExists(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Lightweight existence check. Kept as a function so tests can stub it
 * without touching the filesystem.
 */
function binaryExists(candidate: string): boolean {
  try {
    // Synchronous stat is acceptable here: detection runs once per probe and
    // the registry memoizes results through the detection cache.
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a per-agent config directory under the home directory.
 *
 * @param home - host home directory.
 * @param dirName - relative config dir name, e.g. `.claude`.
 * @returns the absolute config directory path.
 */
export function configDir(home: string, dirName: string): string {
  return `${home.replace(/\/$/, '')}/${dirName}`
}
