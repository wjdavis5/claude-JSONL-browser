import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../session-db-node'
import { duplicateWork, neighborhood, readSessionGraph } from '../session-retrieve'

const dirs: string[] = []
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'session-graphview-'))
  dirs.push(dir)
  return openDatabase(join(dir, 'session.db'), { vectorDims: 2 }).db
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function node(db: DatabaseSync, id: string, kind: string): void {
  db.prepare('INSERT OR REPLACE INTO nodes(id, kind) VALUES (?, ?)').run(id, kind)
}
function edge(db: DatabaseSync, from: string, to: string, type: string): void {
  db.prepare('INSERT OR IGNORE INTO edges(from_id, to_id, type) VALUES (?, ?, ?)').run(from, to, type)
}
function chunk(db: DatabaseSync, sessionId: string, parentId: string): void {
  db.prepare(
    "INSERT INTO chunks(session_id, parent_id, kind, text, text_hash, embedding_status, embedding_model, dims) VALUES (?, ?, 'tool', 'x', ?, 'partial', 'm', 2)",
  ).run(sessionId, parentId, `${sessionId}:${parentId}`)
}

describe('session graph views', () => {
  it('reads a session graph with its nodes and edges', () => {
    const db = freshDb()
    node(db, 'session:s1', 'session')
    node(db, 'tool:s1:t0:0', 'tool')
    node(db, 'file:/repo/x.ts', 'file')
    edge(db, 'session:s1', 'tool:s1:t0:0', 'has')
    edge(db, 'tool:s1:t0:0', 'file:/repo/x.ts', 'edit')

    const graph = readSessionGraph(db, 's1')
    expect(graph.nodes.map((n) => n.id)).toContain('tool:s1:t0:0')
    expect(graph.nodes.map((n) => n.id)).toContain('file:/repo/x.ts')
    expect(graph.edges.some((e) => e.to === 'file:/repo/x.ts' && e.type === 'edit')).toBe(true)
    db.close()
  })

  it('returns the 1-hop neighborhood of a node', () => {
    const db = freshDb()
    node(db, 'a', 'tool')
    node(db, 'b', 'tool')
    node(db, 'c', 'tool')
    edge(db, 'a', 'b', 'x')
    edge(db, 'b', 'c', 'x')
    const near = neighborhood(db, 'a', { depth: 1 })
    const ids = near.nodes.map((n) => n.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
    expect(ids).not.toContain('c')
    db.close()
  })

  it('reports files touched by more than one tool as duplicate work', () => {
    const db = freshDb()
    chunk(db, 's1', 't0:0')
    chunk(db, 's1', 't0:1')
    edge(db, 'tool:s1:t0:0', 'file:/repo/x.ts', 'edit')
    edge(db, 'tool:s1:t0:1', 'file:/repo/x.ts', 'read')
    const duplicates = duplicateWork(db, 's1')
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].file).toBe('/repo/x.ts')
    expect(duplicates[0].tools.length).toBe(2)
    db.close()
  })

  it('does not leak other sessions when the session id contains LIKE wildcards', () => {
    const db = freshDb()
    node(db, 'tool:s1:t0:0', 'tool')
    node(db, 'tool:s2:t0:0', 'tool')
    expect(readSessionGraph(db, '%').nodes.filter((n) => n.id.startsWith('tool:'))).toHaveLength(0)
    db.close()
  })
})
