import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../session-db-node'
import { chunkItems, ingestSession, MAX_CHUNK_CHARS, type IngestItem } from '../session-ingest'
import type { Embedder } from '../session-embed'

const dirs: string[] = []
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'session-ingest-'))
  dirs.push(dir)
  return openDatabase(join(dir, 'session.db'), { vectorDims: 8 }).db
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function countingEmbedder(): Embedder & { calls: number; texts: number } {
  const state = { calls: 0, texts: 0 }
  return {
    model: 'test-model',
    dims: 8,
    get calls() {
      return state.calls
    },
    get texts() {
      return state.texts
    },
    async embed(texts: string[]) {
      state.calls += 1
      state.texts += texts.length
      return texts.map((_, i) => {
        const v = new Float32Array(8)
        v[i % 8] = 1
        return v
      })
    },
  } as Embedder & { calls: number; texts: number }
}

const items = (): IngestItem[] => [
  { parentId: 't0:0', kind: 'prompt', text: 'how do we search sessions' },
  { parentId: 't0:1', kind: 'tool', name: 'Bash', input: { command: 'ls' }, result: 'file-a\nfile-b' },
]

describe('session ingest', () => {
  it('embeds nothing on a second run over unchanged content', async () => {
    const db = freshDb()
    const first = countingEmbedder()
    await ingestSession(db, { sessionId: 's1', items: items(), embedder: first })
    expect(first.texts).toBeGreaterThan(0)

    const second = countingEmbedder()
    const stats = await ingestSession(db, { sessionId: 's1', items: items(), embedder: second })
    expect(second.texts).toBe(0)
    expect(stats.reused).toBe(stats.chunks)
    db.close()
  })

  it('embeds only new chunks when the session grows', async () => {
    const db = freshDb()
    await ingestSession(db, { sessionId: 's1', items: items(), embedder: countingEmbedder() })

    const grown = countingEmbedder()
    const stats = await ingestSession(db, {
      sessionId: 's1',
      items: [...items(), { parentId: 't1:0', kind: 'prompt', text: 'a brand new question' }],
      embedder: grown,
    })
    expect(grown.texts).toBe(1)
    expect(stats.embedded).toBe(1)
    db.close()
  })

  it('completes with partial embeddings when the embedder fails, then backfills', async () => {
    const db = freshDb()
    const failing: Embedder = {
      model: 'test-model',
      dims: 8,
      embed: async () => {
        throw new Error('LM Studio unreachable')
      },
    }
    const stats = await ingestSession(db, { sessionId: 's1', items: items(), embedder: failing })
    expect(stats.partial).toBeGreaterThan(0)
    const partial = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding_status = 'partial'").get() as { n: number }
    expect(partial.n).toBeGreaterThan(0)
    const fts = db.prepare("SELECT rowid FROM fts_chunks WHERE fts_chunks MATCH 'file'").all()
    expect(fts.length).toBeGreaterThan(0)

    const backfill = countingEmbedder()
    await ingestSession(db, { sessionId: 's1', items: items(), embedder: backfill })
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding_status = 'partial'").get() as { n: number }
    expect(remaining.n).toBe(0)
    db.close()
  })

  it('splits oversized text into chunks sharing a parent', () => {
    const big = 'x'.repeat(MAX_CHUNK_CHARS + 100)
    const drafts = chunkItems([{ parentId: 't0:0', kind: 'tool', name: 'Read', result: big }])
    expect(drafts.length).toBeGreaterThan(1)
    expect(new Set(drafts.map((d) => d.parentId)).size).toBe(1)
  })
})
