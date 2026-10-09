import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import * as sqliteVecNs from 'sqlite-vec'
import {
  BASE_SCHEMA_SQL,
  META_SCHEMA_VERSION,
  META_VEC_AVAILABLE,
  META_VECTOR_DIMS,
  SESSION_DB_VERSION,
  VECTOR_DIMS,
  vecSchemaSql,
} from './session-db.ts'

const sqliteVec = ((sqliteVecNs as unknown as { default?: { load: (db: unknown) => void } }).default ??
  (sqliteVecNs as unknown as { load: (db: unknown) => void }))

export class RebuildRequiredError extends Error {
  constructor(found: string | null) {
    super(
      `Session database schema version ${found ?? 'unknown'} is incompatible with ${SESSION_DB_VERSION}; rebuild required.`,
    )
    this.name = 'RebuildRequiredError'
  }
}

export interface OpenOptions {
  vectorDims?: number
  /** Injection seam for tests; defaults to loading the sqlite-vec extension. */
  loadVec?: (db: DatabaseSync) => void
}

export interface OpenResult {
  db: DatabaseSync
  vecAvailable: boolean
  vecError?: string
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
  return row?.value ?? null
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function migrate(db: DatabaseSync, options: { vecAvailable: boolean; vectorDims?: number }): void {
  const dims = options.vectorDims ?? VECTOR_DIMS
  db.exec('BEGIN')
  try {
    db.exec(BASE_SCHEMA_SQL)
    if (options.vecAvailable) db.exec(vecSchemaSql(dims))
    if (getMeta(db, META_SCHEMA_VERSION) === null) setMeta(db, META_SCHEMA_VERSION, String(SESSION_DB_VERSION))
    setMeta(db, META_VEC_AVAILABLE, options.vecAvailable ? '1' : '0')
    setMeta(db, META_VECTOR_DIMS, String(dims))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function assertCompatible(db: DatabaseSync): void {
  const found = getMeta(db, META_SCHEMA_VERSION)
  if (found !== String(SESSION_DB_VERSION)) throw new RebuildRequiredError(found)
}

export function openDatabase(path: string, options: OpenOptions = {}): OpenResult {
  const db = new DatabaseSync(path, { allowExtension: true })
  const dims = options.vectorDims ?? VECTOR_DIMS
  let priorDims: string | null = null
  try {
    priorDims = getMeta(db, META_VECTOR_DIMS)
  } catch {
    priorDims = null
  }
  let vecAvailable = false
  let vecError: string | undefined
  try {
    ;(options.loadVec ?? ((d) => sqliteVec.load(d)))(db)
    vecAvailable = true
  } catch (error) {
    vecError = `sqlite-vec extension failed to load: ${(error as Error).message}`
  }
  // Extension loading is only needed to load sqlite-vec; close the gate afterward.
  try {
    ;(db as unknown as { enableLoadExtension?: (on: boolean) => void }).enableLoadExtension?.(false)
  } catch {
    /* older driver */
  }
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA busy_timeout=5000')
  } catch {
    /* pragmas unsupported */
  }
  if (priorDims !== null && priorDims !== String(dims)) {
    db.close()
    throw new RebuildRequiredError(`vector dims ${priorDims}`)
  }
  migrate(db, { vecAvailable, vectorDims: dims })
  assertCompatible(db)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort: file may be read-only or not yet flushed */
  }
  return { db, vecAvailable, vecError }
}
