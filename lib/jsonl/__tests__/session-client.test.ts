import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHybridSearch } from '../session-index-client'
import { GET } from '../../../app/api/session/[...path]/route'

afterEach(() => vi.restoreAllMocks())

describe('client seam', () => {
  it('uses the API and returns hits when it responds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hits: [{ id: 1, parentId: 't0:0', sessionId: 's1', kind: 'tool', text: 'x', score: 1, legs: ['fts'] }] }), { status: 200 })))
    const hits = await fetchHybridSearch('s1', 'query', { graph: true })
    expect(hits).toHaveLength(1)
    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(calledUrl).toContain('/api/session/search')
    expect(calledUrl).toContain('graph=1')
  })

  it('returns null when the API is unreachable so the caller falls back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    expect(await fetchHybridSearch('s1', 'query')).toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    expect(await fetchHybridSearch('s1', 'query')).toBeNull()
  })
})

describe('retrieval route security', () => {
  const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) })

  it('rejects a non-loopback host', async () => {
    const res = await GET(new Request('http://evil.example/api/session/search?q=x'), ctx(['search']))
    expect(res.status).toBe(403)
  })

  it('rejects an unknown operation', async () => {
    const res = await GET(new Request('http://localhost/api/session/../../etc?q=x'), ctx(['../../etc']))
    expect(res.status).toBe(404)
  })

  it('returns 503 when no database is present (client degrades)', async () => {
    const previous = process.env.SESSION_DB_PATH
    process.env.SESSION_DB_PATH = '/nonexistent/ce-review/session.db'
    try {
      const res = await GET(new Request('http://localhost/api/session/search?q=x'), ctx(['search']))
      expect(res.status).toBe(503)
    } finally {
      if (previous === undefined) delete process.env.SESSION_DB_PATH
      else process.env.SESSION_DB_PATH = previous
    }
  })
})
