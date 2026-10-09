import type { DatabaseSync } from 'node:sqlite'
import { CHUNKER_VERSION, contentHash, normalizeText, type Embedder } from './session-embed.ts'

/** Token-aware ceiling for a single embedded chunk (well under the 2K context). */
export const MAX_CHUNK_CHARS = 8000

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

interface ExistingRow {
  text_hash: string
  embedding_model: string | null
  dims: number | null
  id: number
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

  const existing = new Map<string, number>()
  const rows = db
    .prepare("SELECT id, text_hash, embedding_model, dims FROM chunks WHERE embedding_status = 'complete'")
    .all() as unknown as ExistingRow[]
  for (const row of rows) {
    if (row.embedding_model === embedder.model && row.dims === embedder.dims) existing.set(row.text_hash, row.id)
  }

  db.exec('BEGIN')
  try {
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
    const setComplete = db.prepare("UPDATE chunks SET embedding_status = 'complete' WHERE id = ?")

    const writeComplete = (draft: ChunkDraft, hash: string, vector: Float32Array): void => {
      const row = upsertChunk.get(sessionId, draft.parentId, draft.kind, draft.text, hash, 'complete', embedder.model, embedder.dims) as { id: number }
      const id = Number(row.id)
      deleteVec.run(BigInt(id))
      insertVec.run(BigInt(id), vector)
    }

    const pendingIds: Array<{ id: number; draft: ChunkDraft; hash: string }> = []
    for (const draft of drafts) {
      const hash = chunkKey(embedder.model, embedder.dims, draft.text)
      const reusableId = existing.get(hash)
      const vector = reusableId !== undefined ? readVec(db, reusableId) : null
      if (vector) {
        writeComplete(draft, hash, vector)
        stats.reused += 1
        continue
      }
      const row = upsertChunk.get(sessionId, draft.parentId, draft.kind, draft.text, hash, 'partial', embedder.model, embedder.dims) as { id: number }
      pendingIds.push({ id: Number(row.id), draft, hash })
    }

    if (pendingIds.length > 0) {
      try {
        const vectors = await embedder.embed(pendingIds.map((entry) => entry.draft.text))
        pendingIds.forEach((entry, index) => {
          if (!vectors[index]) return
          deleteVec.run(BigInt(entry.id))
          insertVec.run(BigInt(entry.id), vectors[index])
          setComplete.run(entry.id)
          stats.embedded += 1
        })
      } catch (error) {
        stats.partial += pendingIds.length
        options.onError?.(error as Error)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return stats
}
