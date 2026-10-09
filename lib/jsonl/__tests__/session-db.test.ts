import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RebuildRequiredError,
  assertCompatible,
  getMeta,
  openDatabase,
  setMeta,
} from '../session-db-node'
import { META_SCHEMA_VERSION, META_VEC_AVAILABLE, SESSION_DB_VERSION, VECTOR_DIMS } from '../session-db'

const dirs: string[] = []
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-db-'))
  dirs.push(dir)
  return join(dir, 'session.db')
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('session database schema', () => {
  it('creates the schema and stamps the current version on a fresh path', () => {
    const { db, vecAvailable } = openDatabase(tempDbPath())
    expect(vecAvailable).toBe(true)
    expect(getMeta(db, META_SCHEMA_VERSION)).toBe(String(SESSION_DB_VERSION))
    expect(getMeta(db, META_VEC_AVAILABLE)).toBe('1')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toContain('chunks')
    expect(tables).toContain('nodes')
    expect(tables).toContain('edges')
    expect(tables).toContain('fts_chunks')
    db.close()
  })

  it('raises a rebuild-required error when the stored version is incompatible', () => {
    const path = tempDbPath()
    const { db } = openDatabase(path)
    setMeta(db, META_SCHEMA_VERSION, '0')
    expect(() => assertCompatible(db)).toThrow(RebuildRequiredError)
    db.close()
  })

  it('keeps FTS5 openable when the vector extension fails to load', () => {
    const { db, vecAvailable, vecError } = openDatabase(tempDbPath(), {
      loadVec: () => {
        throw new Error('cannot load extension')
      },
    })
    expect(vecAvailable).toBe(false)
    expect(vecError).toContain('sqlite-vec')
    expect(getMeta(db, META_VEC_AVAILABLE)).toBe('0')
    db.exec("INSERT INTO chunks(session_id, kind, text, text_hash) VALUES ('s1','prompt','hello fts','h1')")
    const hit = db.prepare("SELECT rowid FROM fts_chunks WHERE fts_chunks MATCH 'hello'").all()
    expect(hit).toHaveLength(1)
    db.close()
  })

  it('shares one rowid across chunks, FTS5, and vec0', () => {
    const { db } = openDatabase(tempDbPath())
    const info = db
      .prepare("INSERT INTO chunks(session_id, kind, text, text_hash, embedding_status) VALUES ('s1','tool','searching sessions with sqlite','h2','complete')")
      .run()
    const id = Number(info.lastInsertRowid)
    const vec = new Float32Array(VECTOR_DIMS)
    vec[0] = 1
    db.prepare('INSERT INTO vec_chunks(id, embedding) VALUES (?, ?)').run(BigInt(id), vec)

    const fts = db.prepare('SELECT rowid FROM fts_chunks WHERE fts_chunks MATCH ?').all('sqlite')
    const knn = db.prepare('SELECT id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = 1').all(vec)
    expect(fts.map((r) => Number((r as { rowid: number }).rowid))).toContain(id)
    expect(Number((knn[0] as { id: number }).id)).toBe(id)
    db.close()
  })
})
