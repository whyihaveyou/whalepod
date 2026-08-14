/**
 * Three-layer agent detector.
 *
 * Layer 1 (PATH): resolve the agent binary against the host PATH.
 * Layer 2 (version): run `--version` to confirm the binary is real and
 *   capture its version string.
 * Layer 3 (config): locate the agent's config directory under `$HOME`.
 *
 * Confidence is derived from which layers matched:
 *   - `binary`      — the binary resolved on PATH (version probe optional).
 *   - `config-only` — no binary, but a config directory exists.
 *   - `manual`      — user-registered (handled by the registry, not here).
 *
 * @module @deepseek-ai/dsh-honeycomb-connectors
 */

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import type { AgentDescriptor, AgentKind, Confidence, HostEnvironment, ProbeResult } from '../types.ts'
import { configDir, resolveBinary } from './host-env.ts'

/** Per-layer probe inputs used to drive the three detection layers. */
export interface DetectSpec {
  /** Stable connector id. */
  id: string
  /** Human-readable display name. */
  displayName: string
  /** Coarse agent family. */
  kind: AgentKind
  /** Binary name to resolve on PATH. */
  binaryName: string
  /** Relative config dir name under `$HOME` (e.g. `.claude`). */
  configDirName: string
  /** Version probe argv appended to the binary (defaults to `--version`). */
  versionArgs?: string[]
  /** Capabilities attached to a successful descriptor. */
  capabilities: AgentDescriptor['capabilities']
}

/** Options for the three-layer detector. */
export interface DetectorOptions {
  /** PATH-resolution function (injectable for tests). */
  resolveBinary?: typeof resolveBinary
  /** Config-directory resolution function (injectable for tests). */
  configDir?: typeof configDir
  /** Version-probe runner (injectable for tests). */
  runVersion?: (binPath: string, args: string[]) => { ok: boolean; output?: string }
}

/** Default version probe: spawn the binary with the given args synchronously. */
function defaultRunVersion(binPath: string, args: string[]): { ok: boolean; output?: string } {
  try {
    const result = spawnSync(binPath, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error) return { ok: false }
    const output = (result.stdout ?? '').trim()
    return { ok: result.status === 0, output: output || undefined }
  } catch {
    return { ok: false }
  }
}

/** Default config-dir existence check. */
function configDirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Detector that composes the three layers into an {@link AgentDescriptor}.
 */
export class Detector {
  private readonly resolveBin: typeof resolveBinary
  private readonly mkConfigDir: typeof configDir
  private readonly runVersion: (binPath: string, args: string[]) => { ok: boolean; output?: string }

  constructor(private readonly spec: DetectSpec, options: DetectorOptions = {}) {
    this.resolveBin = options.resolveBinary ?? resolveBinary
    this.mkConfigDir = options.configDir ?? configDir
    this.runVersion = options.runVersion ?? defaultRunVersion
  }

  /**
   * Layer 1 — PATH binary resolution.
   */
  private probePath(host: HostEnvironment): ProbeResult {
    const binPath = this.resolveBin(this.spec.binaryName, host)
    return binPath
      ? { layer: 'path', matched: true, detail: binPath }
      : { layer: 'path', matched: false }
  }

  /**
   * Layer 2 — version probe.
   */
  private probeVersion(binPath: string): ProbeResult {
    const args = this.spec.versionArgs ?? ['--version']
    const result = this.runVersion(binPath, args)
    return result.ok && result.output
      ? { layer: 'version', matched: true, detail: result.output.split('\n')[0] }
      : { layer: 'version', matched: false, detail: result.output }
  }

  /**
   * Layer 3 — config directory.
   */
  private probeConfig(host: HostEnvironment): ProbeResult {
    const path = this.mkConfigDir(host.home, this.spec.configDirName)
    return configDirExists(path)
      ? { layer: 'config', matched: true, detail: path }
      : { layer: 'config', matched: false, detail: path }
  }

  /**
   * Run all three layers and derive a descriptor.
   *
   * @param host - host environment snapshot (detached).
   * @returns an {@link AgentDescriptor} when any layer matched, else `null`.
   */
  detect(host: HostEnvironment): AgentDescriptor | null {
    const pathProbe = this.probePath(host)
    const versionProbe = pathProbe.matched && pathProbe.detail
      ? this.probeVersion(pathProbe.detail)
      : { layer: 'version' as const, matched: false, detail: undefined as string | undefined }
    const configProbe = this.probeConfig(host)

    const probe: ProbeResult[] = [pathProbe, versionProbe, configProbe]

    const confidence: Confidence = pathProbe.matched
      ? 'binary'
      : configProbe.matched
        ? 'config-only'
        : 'manual'

    // No layer matched — the agent is not installed.
    if (!pathProbe.matched && !configProbe.matched) return null

    return {
      id: this.spec.id,
      displayName: this.spec.displayName,
      kind: this.spec.kind,
      binPath: pathProbe.detail,
      version: versionProbe.detail,
      configDir: configProbe.detail,
      confidence,
      capabilities: this.spec.capabilities,
      probe,
    }
  }
}
