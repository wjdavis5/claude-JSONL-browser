import type { DatabaseSync } from 'node:sqlite'
import { CHUNKER_VERSION, contentHash, normalizeText, type Embedder } from './session-embed.ts'

/** Token-aware ceiling for a single embedded chunk (well under the 2K context). */
export const MAX_CHUNK_CHARS = 8000

/** Item kinds worth embedding. Metadata noise (attachments, system notes, reminders) is skipped. */
const EMBED_KINDS = new Set(['prompt', 'text', 'think', 'tool', 'agent', 'compact'])

export interface IngestItem {
  /** Viewer jump target, e.g. `t<turn>:<item>` or `a:<agentId>`. */
  parentId: string
  kind: string
  text?: string
  name?: string
  input?: unknown
  result?: string
  agentId?: string
}

export interface ChunkDraft {
  parentId: string
  kind: string
  text: string
}

export function buildChunkText(item: IngestItem): string {
  const parts: string[] = []
  if (item.kind === 'tool' || item.kind === 'agent') {
    if (item.name) parts.push(`tool: ${item.name}`)
    if (item.input !== undefined) {
      try {
        parts.push(typeof item.input === 'string' ? item.input : JSON.stringify(item.input))
      } catch {
        /* ignore unserializable input */
      }
    }
    if (item.result) parts.push(item.result)
  }
  if (parts.length === 0 && item.text) parts.push(item.text)
  return normalizeText(parts.join('\n'))
}

/** Turn-pair / tool-pair / agent-item chunks, splitting oversized text under a shared parent. */
export function chunkItems(items: IngestItem[]): ChunkDraft[] {
  const drafts: ChunkDraft[] = []
  for (const item of items) {
    if (!EMBED_KINDS.has(item.kind)) continue
    const text = buildChunkText(item)
    if (!text) continue
    if (text.length <= MAX_CHUNK_CHARS) {
      drafts.push({ parentId: item.parentId, kind: item.kind, text })
      continue
    }
    for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
      drafts.push({ parentId: item.parentId, kind: item.kind, text: text.slice(i, i + MAX_CHUNK_CHARS) })
    }
  }
  return drafts
}

export interface IngestOptions {
  sessionId: string
  items: IngestItem[]
  embedder: Embedder
  onError?: (error: Error) => void
}

export interface IngestStats {
  chunks: number
  embedded: number
  reused: number
  partial: number
}

function chunkKey(model: string, dims: number, text: string): string {
  return contentHash([model, String(dims), String(CHUNKER_VERSION), text])
}

function readVec(db: DatabaseSync, id: number): Float32Array | null {
  const row = db.prepare('SELECT embedding FROM vec_chunks WHERE id = ?').get(BigInt(id)) as { embedding?: Uint8Array } | undefined
  if (!row?.embedding) return null
  const blob = row.embedding
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4))
}

/**
 * Ingest a session's items into the database. Content-addressed: a chunk whose
 * hash, model, and dims already exist complete is reused without re-embedding.
 * When the embedder fails, rows are written `partial` (FTS5 still populated)
 * and a later run backfills them.
 */
export async function ingestSession(db: DatabaseSync, options: IngestOptions): Promise<IngestStats> {
  const { sessionId, items, embedder } = options
  const drafts = chunkItems(items)
  const stats: IngestStats = { chunks: drafts.length, embedded: 0, reused: 0, partial: 0 }

  const lookup = db.prepare(
    "SELECT id FROM chunks WHERE text_hash = ? AND embedding_model = ? AND dims = ? AND embedding_status = 'complete' LIMIT 1",
  )

  const prepared: Array<{ draft: ChunkDraft; hash: string; vector: Float32Array }> = []
  const pending: Array<{ draft: ChunkDraft; hash: string }> = []
  for (const draft of drafts) {
    const hash = chunkKey(embedder.model, embedder.dims, draft.text)
    const row = lookup.get(hash, embedder.model, embedder.dims) as { id: number } | undefined
    const vector = row ? readVec(db, Number(row.id)) : null
    if (vector) {
      prepared.push({ draft, hash, vector })
      stats.reused += 1
    } else {
      pending.push({ draft, hash })
    }
  }

  // Stream embeddings and writes in groups so progress is visible and partial
  // results are queryable while a long ingest runs.
  const upsertChunk = db.prepare(
    `INSERT INTO chunks(session_id, parent_id, kind, text, text_hash, embedding_status, embedding_model, dims)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, parent_id, text_hash) DO UPDATE SET
       kind = excluded.kind,
       text = excluded.text,
       embedding_status = excluded.embedding_status,
       embedding_model = excluded.embedding_model,
       dims = excluded.dims
     RETURNING id`,
  )
  const deleteVec = db.prepare('DELETE FROM vec_chunks WHERE id = ?')
  const insertVec = db.prepare('INSERT INTO vec_chunks(id, embedding) VALUES (?, ?)')
  const progress = db.prepare(
    `INSERT INTO ingest_progress(session_id, processed, total, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET processed = excluded.processed, total = excluded.total, updated_at = excluded.updated_at`,
  )
  const storeVector = (id: number, vector: Float32Array): void => {
    deleteVec.run(BigInt(id))
    insertVec.run(BigInt(id), vector)
  }
  const writeGroup = (entries: Array<{ draft: ChunkDraft; hash: string; vector: Float32Array | null }>, countEmbedded: boolean): void => {
    if (entries.length === 0) return
    db.exec('BEGIN')
    try {
      for (const { draft, hash, vector } of entries) {
        const row = upsertChunk.get(sessionId, draft.parentId, draft.kind, draft.text, hash, vector ? 'complete' : 'partial', embedder.model, embedder.dims) as { id: number }
        if (vector) {
          storeVector(Number(row.id), vector)
          if (countEmbedded) stats.embedded += 1
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const total = drafts.length
  const markProgress = (processed: number): void => {
    progress.run(sessionId, processed, total, new Date().toISOString())
  }

  // Reused (already-complete) chunks write in one group.
  writeGroup(prepared.map((entry) => ({ draft: entry.draft, hash: entry.hash, vector: entry.vector })), false)
  let processed = prepared.length
  markProgress(processed)

  // Pending chunks embed and write in bounded groups.
  const STREAM = 256
  for (let i = 0; i < pending.length; i += STREAM) {
    const group = pending.slice(i, i + STREAM)
    let vectors: Float32Array[] = []
    let failed = false
    try {
      vectors = await embedder.embed(group.map((entry) => entry.draft.text))
    } catch (error) {
      failed = true
      stats.partial += group.length
      options.onError?.(error as Error)
    }
    writeGroup(group.map((entry, index) => ({ draft: entry.draft, hash: entry.hash, vector: failed ? null : (vectors[index] ?? null) })), true)
    processed += group.length
    markProgress(processed)
  }

  // Prune chunks that this run no longer produces (edited/removed items).
  const newKeys = new Set<string>()
  for (const entry of prepared) newKeys.add(`${entry.draft.parentId}\u0000${entry.hash}`)
  for (const entry of pending) newKeys.add(`${entry.draft.parentId}\u0000${entry.hash}`)
  db.exec('BEGIN')
  try {
    const existingRows = db.prepare('SELECT id, parent_id, text_hash FROM chunks WHERE session_id = ?').all(sessionId) as unknown as Array<{
      id: number
      parent_id: string | null
      text_hash: string
    }>
    const deleteChunk = db.prepare('DELETE FROM chunks WHERE id = ?')
    for (const row of existingRows) {
      if (!newKeys.has(`${row.parent_id}\u0000${row.text_hash}`)) {
        deleteVec.run(BigInt(row.id))
        deleteChunk.run(row.id)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return stats
}
