import { existsSync } from 'node:fs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const OPERATIONS = new Set(['search'])

function forbidden(reason: string): Response {
  return Response.json({ error: reason }, { status: 403 })
}

/**
 * Local retrieval API. Fixed operation enum (never a filesystem path), host and
 * origin validation, parameterized queries (escaped FTS term lives in the
 * retrieval module), and a loopback-only LM Studio endpoint.
 */
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const url = new URL(request.url)
  if (!LOOPBACK.has(url.hostname)) return forbidden('non-loopback host')
  const origin = request.headers.get('origin')
  if (origin) {
    try {
      if (!LOOPBACK.has(new URL(origin).hostname)) return forbidden('cross-origin')
    } catch {
      return forbidden('invalid origin')
    }
  }

  const { path } = await context.params
  const operation = path?.[0] ?? ''
  if (!OPERATIONS.has(operation)) return Response.json({ error: 'unknown operation' }, { status: 404 })

  const token = process.env.SESSION_API_TOKEN
  if (token && request.headers.get('authorization') !== `Bearer ${token}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const dbPath = process.env.SESSION_DB_PATH ?? 'data/session.db'
  if (!existsSync(dbPath)) return Response.json({ error: 'no database' }, { status: 503 })

  const q = url.searchParams.get('q') ?? ''
  const sessionId = url.searchParams.get('sessionId') ?? undefined
  const k = Math.min(Math.max(Number(url.searchParams.get('k')) || 20, 1), 100)
  const graph = url.searchParams.get('graph') === '1'

  const { openDatabase } = await import('../../../../lib/jsonl/session-db-node')
  const { hybridSearch, graphExpandedSearch } = await import('../../../../lib/jsonl/session-retrieve')
  const { createLmStudioEmbedder } = await import('../../../../lib/jsonl/session-embed')

  let opened: ReturnType<typeof openDatabase>
  try {
    opened = openDatabase(dbPath)
  } catch {
    return Response.json({ error: 'database unavailable' }, { status: 503 })
  }
  const db = opened.db
  try {
    let vector: Float32Array | undefined
    try {
      const embedder = createLmStudioEmbedder()
      vector = await embedder.embedQuery?.(q)
    } catch {
      /* lexical-only when LM Studio is unavailable */
    }
    const hits = graph
      ? graphExpandedSearch(db, { text: q, vector, k, sessionId })
      : hybridSearch(db, { text: q, vector, k, sessionId })
    return Response.json({ hits })
  } catch {
    return Response.json({ error: 'retrieval failed' }, { status: 503 })
  } finally {
    db.close()
  }
}
