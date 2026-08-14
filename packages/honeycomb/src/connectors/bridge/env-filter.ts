/**
 * Environment whitelist for subprocess inheritance.
 *
 * External CLI agents are spawned with a *filtered* environment: only a
 * curated whitelist of keys is forwarded from the host. This prevents leaking
 * host credentials (API keys, tokens) into third-party agent processes while
 * still passing through the keys needed for normal operation.
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

/**
 * Default whitelist of environment keys forwarded to spawned agents.
 *
 * Deliberately excludes credential-shaped keys (`*_API_KEY`, `*_TOKEN`,
 * `AWS_*`, `AZURE_*`, etc.). Adapt with caution: forwarding credentials to a
 * third-party agent process is an explicit security decision.
 */
export const DEFAULT_ENV_WHITELIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TERM_PROGRAM',
  'COLORTERM',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'SSH_AUTH_SOCK',
  'NODE_ENV',
]

/**
 * Filter an environment record down to the whitelist (plus any explicit
 * overrides, which are always allowed).
 *
 * @param env - the full source environment (e.g. `process.env`).
 * @param whitelist - allowed keys (defaults to {@link DEFAULT_ENV_WHITELIST}).
 * @param overrides - explicit overrides, always included regardless of whitelist.
 * @returns a filtered environment record suitable for `spawn`.
 */
export function filterEnv(
  env: NodeJS.ProcessEnv,
  whitelist: readonly string[] = DEFAULT_ENV_WHITELIST,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const allowed = new Set(whitelist)
  const result: NodeJS.ProcessEnv = {}

  for (const key of Object.keys(env)) {
    if (allowed.has(key) && env[key] !== undefined) {
      result[key] = env[key]
    }
  }

  for (const key of Object.keys(overrides)) {
    if (overrides[key] !== undefined) result[key] = overrides[key]
  }

  return result
}
