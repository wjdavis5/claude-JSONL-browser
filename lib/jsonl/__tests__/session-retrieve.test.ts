import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../session-db-node'
import { hybridSearch, VEC_KNN_CAP } from '../session-retrieve'

const dirs: string[] = []
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'session-retrieve-'))
  dirs.push(dir)
  return openDatabase(join(dir, 'session.db'), { vectorDims: 2 }).db
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function seed(db: DatabaseSync, text: string, vector?: Float32Array): number {
  const info = db
    .prepare(
      "INSERT INTO chunks(session_id, parent_id, kind, text, text_hash, embedding_status, embedding_model, dims) VALUES ('s1', ?, 'tool', ?, ?, 'complete', 'm', 2)",
    )
    .run(text, text, text)
  const id = Number(info.lastInsertRowid)
  if (vector) db.prepare('INSERT INTO vec_chunks(id, embedding) VALUES (?, ?)').run(BigInt(id), vector)
  return id
}

describe('hybrid search', () => {
  it('returns both a lexical-only and a semantic-only hit, ranked by fused score', () => {
    const db = freshDb()
    seed(db, 'the quick brown fox jumps')
    const semantic = new Float32Array([1, 0])
    seed(db, 'entirely unrelated wording here', semantic)

    const hits = hybridSearch(db, { text: 'quick', vector: semantic })
    const legs = hits.flatMap((h) => h.legs)
    expect(legs).toContain('fts')
    expect(legs).toContain('vec')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    db.close()
  })

  it('clamps a k above the vec0 KNN cap without erroring', () => {
    const db = freshDb()
    seed(db, 'alpha', new Float32Array([1, 0]))
    expect(() => hybridSearch(db, { text: 'alpha', vector: new Float32Array([1, 0]), k: 100000 })).not.toThrow()
    expect(VEC_KNN_CAP).toBe(4096)
    db.close()
  })

  it('returns nothing for an empty query', () => {
    const db = freshDb()
    seed(db, 'something')
    expect(hybridSearch(db, { text: '   ' })).toEqual([])
    db.close()
  })

  it('finds an identifier substring via the trigram leg', () => {
    const db = freshDb()
    seed(db, 'edited lib/session-index.ts today')
    const hits = hybridSearch(db, { text: 'dex.ts' })
    expect(hits.some((h) => h.legs.includes('trigram'))).toBe(true)
    db.close()
  })
})
