import type { DatabaseSync } from 'node:sqlite'
import { graphNodeId, parseGraphNodeId } from './session-db.ts'

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

/** Quote each query term so FTS5 operators cannot inject syntax; terms are AND-ed. */
export function escapeFtsMatch(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' ')
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
          WHERE ${table} MATCH ? AND (? IS NULL OR c.session_id = ?)
          ORDER BY f.rank LIMIT ?`
        const rows = db.prepare(sql).all(match, query.sessionId ?? null, query.sessionId ?? null, legK) as unknown as ChunkMeta[]
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
        const sql = `SELECT id, parent_id, session_id, kind, text FROM chunks WHERE id IN (${placeholders}) AND (? IS NULL OR session_id = ?)`
        const rows = db.prepare(sql).all(...ids, query.sessionId ?? null, query.sessionId ?? null) as unknown as ChunkMeta[]
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

// ---------------------------------------------------------------------------
// Graph traversal and graph-expanded retrieval
// ---------------------------------------------------------------------------

export const GRAPH_MAX_DEPTH = 8
export const GRAPH_NODE_BUDGET = 2000

export function chunkToNodeId(chunk: { sessionId: string; parentId: string | null; kind: string }): string | null {
  if (!chunk.parentId) return null
  const kind = chunk.kind === 'agent' ? 'agent' : 'tool'
  return graphNodeId(kind, `${chunk.sessionId}:${chunk.parentId}`)
}

/** Bounded, cycle-safe BFS over `edges`; returns nodeId -> hop distance. */
export function traverse(
  db: DatabaseSync,
  seeds: string[],
  options: { maxDepth?: number; nodeBudget?: number } = {},
): Map<string, number> {
  const maxDepth = options.maxDepth ?? GRAPH_MAX_DEPTH
  const nodeBudget = options.nodeBudget ?? GRAPH_NODE_BUDGET
  const reach = new Map<string, number>()
  const queue: Array<[string, number]> = []
  let head = 0
  for (const seed of seeds) {
    if (!reach.has(seed)) {
      reach.set(seed, 0)
      queue.push([seed, 0])
    }
  }
  const stmt = db.prepare('SELECT from_id, to_id FROM edges WHERE from_id = ? OR to_id = ?')
  while (head < queue.length && reach.size < nodeBudget) {
    const [node, depth] = queue[head++]
    if (depth >= maxDepth) continue
    const rows = stmt.all(node, node) as unknown as Array<{ from_id: string; to_id: string }>
    for (const edge of rows) {
      const next = edge.from_id === node ? edge.to_id : edge.from_id
      if (reach.has(next)) continue
      reach.set(next, depth + 1)
      queue.push([next, depth + 1])
      if (reach.size >= nodeBudget) break
    }
  }
  return reach
}

function chunksForNode(statement: { all: (sessionId: string, parentId: string) => unknown }, nodeId: string): HybridHit[] {
  const parts = parseGraphNodeId(nodeId)
  if (!parts || (parts.kind !== 'tool' && parts.kind !== 'agent')) return []
  const rows = statement.all(parts.sessionId, parts.key) as unknown as ChunkMeta[]
  return rows.map((row) => ({
    id: Number(row.id),
    parentId: row.parent_id,
    sessionId: row.session_id,
    kind: row.kind,
    text: truncate(row.text, 400),
    score: 0,
    legs: [],
  }))
}

export interface GraphSearchOptions extends HybridQuery {
  maxDepth?: number
  nodeBudget?: number
  graphWeight?: number
}

/** Hybrid search reranked and augmented by bounded graph proximity. */
export function graphExpandedSearch(db: DatabaseSync, query: GraphSearchOptions): HybridHit[] {
  const k = query.k ?? 20
  const hits = hybridSearch(db, query)
  if (hits.length === 0) return hits

  const seeds = hits.map((h) => chunkToNodeId(h)).filter((id): id is string => Boolean(id))
  const reach = traverse(db, seeds, { maxDepth: query.maxDepth, nodeBudget: query.nodeBudget })

  const byId = new Map<number, HybridHit>(hits.map((h) => [h.id, h]))

  // Add graph-reachable chunks (nearest hops first), bounded by k additions.
  const reachable = [...reach.entries()]
    .filter(([nodeId, hop]) => hop > 0 && (nodeId.startsWith('tool:') || nodeId.startsWith('agent:')))
    .sort((a, b) => a[1] - b[1])
  let added = 0
  const chunkStmt = db.prepare('SELECT id, parent_id, session_id, kind, text FROM chunks WHERE session_id = ? AND parent_id = ?')
  for (const [nodeId] of reachable) {
    if (added >= k) break
    for (const chunk of chunksForNode(chunkStmt, nodeId)) {
      if (byId.has(chunk.id)) continue
      chunk.legs = ['graph']
      byId.set(chunk.id, chunk)
      added += 1
      if (added >= k) break
    }
  }

  const graphWeight = query.graphWeight ?? 0.3
  for (const hit of byId.values()) {
    const nodeId = chunkToNodeId(hit)
    const hop = nodeId ? reach.get(nodeId) : undefined
    if (hop !== undefined) {
      hit.legs = [...new Set([...hit.legs, 'graph'])]
      hit.score += graphWeight / (1 + hop)
    }
  }

  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, k)
}

// ---------------------------------------------------------------------------
// Graph views (nodes/edges for visualization and navigation)
// ---------------------------------------------------------------------------

export interface GraphNodeView {
  id: string
  kind: string
  label: string
  degree: number
}

export interface GraphEdgeView {
  from: string
  to: string
  type: string
}

export interface SessionGraphView {
  nodes: GraphNodeView[]
  edges: GraphEdgeView[]
  truncated: boolean
  duplicates: DuplicateWorkGroup[]
}

function nodeLabel(id: string): string {
  const colon = id.indexOf(':')
  const kind = id.slice(0, colon)
  const rest = id.slice(colon + 1)
  if (kind === 'session' || kind === 'file' || kind === 'pr') return rest
  const second = rest.indexOf(':')
  return second >= 0 ? rest.slice(second + 1) : rest
}

function collectGraph(db: DatabaseSync, ids: string[], limit: number): { nodes: GraphNodeView[]; edges: GraphEdgeView[]; truncated: boolean } {
  const edges = ids.length
    ? (db
        .prepare(`SELECT from_id, to_id, type FROM edges WHERE from_id IN (${ids.map(() => '?').join(',')}) AND to_id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids, ...ids) as unknown as Array<{ from_id: string; to_id: string; type: string }>)
    : []
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.from_id, (degree.get(edge.from_id) ?? 0) + 1)
    degree.set(edge.to_id, (degree.get(edge.to_id) ?? 0) + 1)
  }
  const kindRows = ids.length
    ? (db.prepare(`SELECT id, kind FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as Array<{ id: string; kind: string }>)
    : []
  const kindById = new Map(kindRows.map((row) => [row.id, row.kind]))
  let nodes: GraphNodeView[] = ids.map((id) => ({ id, kind: kindById.get(id) ?? 'unknown', label: nodeLabel(id), degree: degree.get(id) ?? 0 }))
  let truncated = false
  if (nodes.length > limit) {
    truncated = true
    nodes = nodes.sort((a, b) => b.degree - a.degree).slice(0, limit)
  }
  const keep = new Set(nodes.map((node) => node.id))
  const keptEdges = edges.filter((edge) => keep.has(edge.from_id) && keep.has(edge.to_id)).map((edge) => ({ from: edge.from_id, to: edge.to_id, type: edge.type }))
  return { nodes, edges: keptEdges, truncated }
}

/** Escapes LIKE metacharacters so a session id cannot match other sessions' rows. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

/** Nodes and edges for one session (session + a bounded set of its item nodes + their file/pr nodes). */
export function readSessionGraph(db: DatabaseSync, sessionId: string, options: { limit?: number } = {}): SessionGraphView {
  const limit = options.limit ?? 300
  const sid = escapeLike(sessionId)
  // Bounded seed: do NOT expand the session hub (it has a `has` edge to every item).
  const items = db
    .prepare("SELECT id FROM nodes WHERE id LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' ORDER BY id LIMIT ?")
    .all(`tool:${sid}:%`, `agent:${sid}:%`, limit) as unknown as Array<{ id: string }>
  const itemIds = items.map((row) => row.id)
  const targets = itemIds.length
    ? (db
        .prepare(`SELECT DISTINCT to_id AS id FROM edges WHERE from_id IN (${itemIds.map(() => '?').join(',')})`)
        .all(...itemIds) as unknown as Array<{ id: string }>)
    : []
  const ids = [...new Set([`session:${sessionId}`, ...itemIds, ...targets.map((row) => row.id)])].slice(0, limit * 4)
  const duplicates = duplicateWork(db, sessionId).slice(0, limit)
  return { ...collectGraph(db, ids, limit), duplicates }
}

/** Bounded neighborhood of a node, for the viewer's neighborhood lens. */
export function neighborhood(db: DatabaseSync, nodeId: string, options: { depth?: number; limit?: number } = {}): SessionGraphView {
  const reach = traverse(db, [nodeId], { maxDepth: options.depth ?? 1, nodeBudget: options.limit ?? 200 })
  return { ...collectGraph(db, [...reach.keys()], options.limit ?? 200), duplicates: [] }
}

export interface DuplicateWorkGroup {
  file: string
  tools: string[]
}

/** Files touched by more than one tool/agent in a session — a duplicate-work signal. */
export function duplicateWork(db: DatabaseSync, sessionId: string): DuplicateWorkGroup[] {
  const rows = db
    .prepare("SELECT from_id AS tool, to_id AS file FROM edges WHERE type IN ('read','edit','write') AND from_id LIKE ? ESCAPE '\\'")
    .all(`tool:${escapeLike(sessionId)}:%`) as unknown as Array<{ tool: string; file: string }>
  const byFile = new Map<string, Set<string>>()
  for (const row of rows) {
    const set = byFile.get(row.file) ?? new Set<string>()
    set.add(nodeLabel(row.tool))
    byFile.set(row.file, set)
  }
  return [...byFile.entries()].filter(([, tools]) => tools.size > 1).map(([file, tools]) => ({ file: nodeLabel(file), tools: [...tools] }))
}
