import type { DatabaseSync } from 'node:sqlite'

export const RRF_K = 60
/** sqlite-vec's default KNN k cap. */
export const VEC_KNN_CAP = 4096

export interface HybridQuery {
  text: string
  /** Query embedding; when absent the search is lexical-only. */
  vector?: Float32Array
  k?: number
  sessionId?: string
}

export interface HybridHit {
  id: number
  parentId: string | null
  sessionId: string
  kind: string
  text: string
  score: number
  legs: string[]
}

interface ChunkMeta {
  id: number
  parent_id: string | null
  session_id: string
  kind: string
  text: string
}

/** Wrap the user term as a quoted FTS5 phrase so operators cannot inject syntax. */
export function escapeFtsMatch(text: string): string {
  return `"${text.replace(/"/g, '""')}"`
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit)
}

export function hybridSearch(db: DatabaseSync, query: HybridQuery): HybridHit[] {
  const k = query.k ?? 20
  const legK = Math.min(Math.max(k * 5, 50), VEC_KNN_CAP)
  if (!query.text.trim() && !query.vector) return []

  const accum = new Map<number, { score: number; legs: Set<string>; row: ChunkMeta }>()
  const addLeg = (rows: ChunkMeta[], leg: string): void => {
    rows.forEach((row, index) => {
      const id = Number(row.id)
      const entry = accum.get(id) ?? { score: 0, legs: new Set<string>(), row }
      entry.score += 1 / (RRF_K + index + 1)
      entry.legs.add(leg)
      accum.set(id, entry)
    })
  }

  if (query.text.trim()) {
    const match = escapeFtsMatch(query.text)
    const tables: Array<[string, string]> = [
      ['fts_chunks', 'fts'],
      ['fts_chunks_tri', 'trigram'],
    ]
    for (const [table, leg] of tables) {
      try {
        const sql = `SELECT c.id, c.parent_id, c.session_id, c.kind, c.text
          FROM ${table} f JOIN chunks c ON c.id = f.rowid
          WHERE ${table} MATCH ? ${query.sessionId ? 'AND c.session_id = ?' : ''}
          ORDER BY f.rank LIMIT ?`
        const rows = (query.sessionId ? db.prepare(sql).all(match, query.sessionId, legK) : db.prepare(sql).all(match, legK)) as unknown as ChunkMeta[]
        addLeg(rows, leg)
      } catch {
        /* optional index unavailable */
      }
    }
  }

  if (query.vector) {
    try {
      const knn = db.prepare('SELECT id FROM vec_chunks WHERE embedding MATCH ? AND k = ?').all(query.vector, legK) as unknown as Array<{ id: number }>
      const ids = knn.map((r) => Number(r.id))
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',')
        const rows = db.prepare(`SELECT id, parent_id, session_id, kind, text FROM chunks WHERE id IN (${placeholders})`).all(...ids) as unknown as ChunkMeta[]
        const byId = new Map(rows.map((r) => [Number(r.id), r]))
        addLeg(ids.map((id) => byId.get(id)).filter((r): r is ChunkMeta => Boolean(r)), 'vec')
      }
    } catch {
      /* vector leg unavailable */
    }
  }

  return [...accum.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((entry) => ({
      id: Number(entry.row.id),
      parentId: entry.row.parent_id,
      sessionId: entry.row.session_id,
      kind: entry.row.kind,
      text: truncate(entry.row.text, 400),
      score: entry.score,
      legs: [...entry.legs],
    }))
}
