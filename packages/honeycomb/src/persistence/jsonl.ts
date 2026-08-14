/**
 * File-backed append-only fact log (`jsonl` backend) (§9.3).
 *
 * Each hive gets its own append-only file:
 *
 *     <dir>/<hiveId>/facts.ndjson
 *
 * where `<hiveId>` is URL-safe encoded. Each line is one JSON-serialised
 * {@link FactRecord}, appended in order. On startup the store replays the file
 * back into the derived snapshot.
 *
 * Corruption tolerance: a line that fails to parse (or that deserialises to an
 * object without a valid shape) is **skipped** and counted, and a warning is
 * reported via `onWarn` (default `console.warn`). A corrupt line never aborts
 * startup or replay.
 *
 * @module @dfh/honeycomb/persistence/jsonl
 */

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FactBackend, FactStore } from './store'
import type { FactRecord, HiveFact } from './facts'

export interface JsonlFactBackendOptions {
  /** Root directory under which per-hive `facts.ndjson` files live. */
  dir?: string
  /**
   * Called when a line is skipped due to corruption. Defaults to `console.warn`.
   * Timed to never throw — warned + skipped.
   */
  onWarn?: (message: string, detail: unknown) => void
}

/** Filename for a hive's append-only fact log. */
export const FACT_LOG_FILE = 'facts.ndjson'

/** Default backend directory: `~/.dfh/hive` (mirrors harness `$DSH_HOME` convention). */
export function defaultFactDir(): string {
  return join(homedir(), '.dfh', 'hive')
}

/** The known fact `type` vocabulary, as a runtime set (kept in sync with facts.ts). */
const KNOWN_FACT_TYPES = new Set<string>([
  'hive-created',
  'hive-renamed',
  'hive-updated',
  'hive-removed',
  'member-registered',
  'member-renamed',
  'member-status',
  'member-dismissed',
  'task-created',
  'task-updated',
  'task-dependency',
  'message-created',
  'message-read',
])

/** URL-safe encode a hive id for use as a directory segment. */
function encodeHiveId(hiveId: string): string {
  return encodeURIComponent(hiveId)
}

/** A result of reading one file: valid records plus how many lines were skipped. */
interface FileRead {
  records: FactRecord[]
  skipped: number
}

/**
 * Append-only JSON Lines backend.
 *
 * - `append(record)` writes one NDJSON line to `<dir>/<hiveId>/facts.ndjson`.
 * - `replay(hiveId?)` re-reads and re-parses the file(s). Corrupt lines are
 *   skipped and warned; a missing file is treated as an empty log.
 * - The in-memory snapshot cache lives in the {@link FactStore}; this backend
 *   is deliberately stateless between writes/reads (crash-safe append-only).
 */
export class JsonlFactBackend implements FactBackend {
  readonly dir: string
  readonly onWarn: (message: string, detail: unknown) => void

  constructor(options: JsonlFactBackendOptions = {}) {
    this.dir = options.dir ?? defaultFactDir()
    this.onWarn = options.onWarn ?? ((message) => console.warn(message))
  }

  /** Absolute path to a hive's fact log file. */
  filePath(hiveId: string): string {
    return join(this.dir, encodeHiveId(hiveId), FACT_LOG_FILE)
  }

  async append(record: FactRecord): Promise<void> {
    const path = this.filePath(record.hiveId)
    await mkdir(join(this.dir, encodeHiveId(record.hiveId)), { recursive: true })
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
  }

  async replay(hiveId?: string): Promise<FactRecord[]> {
    if (hiveId !== undefined) {
      const { records, skipped } = await this.readFileSafe(this.filePath(hiveId))
      if (skipped > 0) this.onWarn(`jsonl: skipped ${skipped} corrupt line(s) in ${this.filePath(hiveId)}`, { skipped })
      return records
    }

    // No hive scope → read every hive's log under <dir> and concatenate in a
    // stable order (path-sorted) so full-store replay is deterministic.
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(this.dir, { withFileTypes: true })
    } catch {
      return [] // directory not created yet → empty log
    }

    const paths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(this.dir, entry.name, FACT_LOG_FILE))
      .sort()

    const records: FactRecord[] = []
    for (const path of paths) {
      const { records: fileRecords, skipped } = await this.readFileSafe(path)
      if (skipped > 0) this.onWarn(`jsonl: skipped ${skipped} corrupt line(s) in ${path}`, { skipped })
      records.push(...fileRecords)
    }
    return records
  }

  /** Read + parse one NDJSON file, skipping corrupt lines. Missing file → empty. */
  private async readFileSafe(path: string): Promise<FileRead> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return { records: [], skipped: 0 } // file not present (or raced removal) → empty
    }

    const records: FactRecord[] = []
    let skipped = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      const record = this.tryParse(line)
      if (record !== null) records.push(record)
      else skipped += 1
    }
    return { records, skipped }
  }

  /** Parse a single line; return a validated record, or `null` to skip+count. */
  private tryParse(line: string): FactRecord | null {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      return null
    }
    if (typeof obj !== 'object' || obj === null) return null
    const r = obj as Partial<{ seq: unknown; at: unknown; hiveId: unknown; fact: unknown }>
    if (typeof r.seq !== 'number' || typeof r.at !== 'number' || typeof r.hiveId !== 'string') return null
    if (!isKnownFact(r.fact)) return null
    return { seq: r.seq, at: r.at, hiveId: r.hiveId, fact: r.fact }
  }
}

/** Structural guard: a fact is an object whose `type` is a known vocabulary key. */
function isKnownFact(value: unknown): value is HiveFact {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && KNOWN_FACT_TYPES.has(type)
}
