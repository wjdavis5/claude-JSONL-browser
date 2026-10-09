import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../session-db-node'
import { graphExpandedSearch, traverse } from '../session-retrieve'

const dirs: string[] = []
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'session-graph-retrieve-'))
  dirs.push(dir)
  return openDatabase(join(dir, 'session.db'), { vectorDims: 2 }).db
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function chunk(db: DatabaseSync, sessionId: string, parentId: string, text: string): number {
  const info = db
    .prepare(
      "INSERT INTO chunks(session_id, parent_id, kind, text, text_hash, embedding_status, embedding_model, dims) VALUES (?, ?, 'tool', ?, ?, 'partial', 'm', 2)",
    )
    .run(sessionId, parentId, text, `${sessionId}:${parentId}`)
  return Number(info.lastInsertRowid)
}
function edge(db: DatabaseSync, from: string, to: string, type: string): void {
  db.prepare('INSERT INTO edges(from_id, to_id, type) VALUES (?, ?, ?)').run(from, to, type)
}

describe('graph-expanded retrieval', () => {
  it('adds a graph-connected chunk that the query did not match', () => {
    const db = freshDb()
    chunk(db, 's1', 't0:0', 'alpha the target phrase')
    chunk(db, 's1', 't0:1', 'beta completely different words')
    edge(db, 'session:s1', 'tool:s1:t0:0', 'has')
    edge(db, 'session:s1', 'tool:s1:t0:1', 'has')

    const hits = graphExpandedSearch(db, { text: 'alpha', k: 10 })
    expect(hits.some((h) => h.parentId === 't0:0')).toBe(true)
    const connected = hits.find((h) => h.parentId === 't0:1')
    expect(connected?.legs).toContain('graph')
    db.close()
  })

  it('terminates on a cycle and respects the depth cap', () => {
    const db = freshDb()
    edge(db, 'a', 'b', 'x')
    edge(db, 'b', 'a', 'x')
    const reach = traverse(db, ['a'], { maxDepth: 8 })
    expect(reach.get('a')).toBe(0)
    expect(reach.get('b')).toBe(1)
    expect(reach.size).toBe(2)
    db.close()
  })

  it('degrades to hybrid hits when the graph is empty', () => {
    const db = freshDb()
    chunk(db, 's1', 't0:0', 'alpha')
    chunk(db, 's1', 't0:1', 'beta')
    const hits = graphExpandedSearch(db, { text: 'alpha', k: 10 })
    expect(hits.some((h) => h.parentId === 't0:0')).toBe(true)
    expect(hits.some((h) => h.parentId === 't0:1')).toBe(false)
    db.close()
  })

  it('reaches a chunk in another session through a shared file node', () => {
    const db = freshDb()
    chunk(db, 'sA', 't0:0', 'alpha in session A')
    chunk(db, 'sB', 't0:0', 'unrelated text in session B')
    edge(db, 'tool:sA:t0:0', 'file:/repo/x.ts', 'edit')
    edge(db, 'tool:sB:t0:0', 'file:/repo/x.ts', 'read')

    const hits = graphExpandedSearch(db, { text: 'alpha', k: 10 })
    const crossSession = hits.find((h) => h.sessionId === 'sB')
    expect(crossSession?.legs).toContain('graph')
    db.close()
  })
})
