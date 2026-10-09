/**
 * Session database schema (pure, no relative imports).
 *
 * One SQLite file holds the full untruncated transcript text (`chunks`), an
 * FTS5 external-content index, a `sqlite-vec` vector table keyed on the same
 * rowid, and the session graph (`nodes`/`edges`). This module is deliberately
 * dependency-free so Node can execute it via type stripping from the CLI and
 * the app can import it.
 */

export const SESSION_DB_VERSION = 1

export const META_SCHEMA_VERSION = 'schema_version'
export const META_VEC_AVAILABLE = 'vec_available'
export const META_BUILD_EPOCH = 'build_epoch'
export const META_EMBEDDING_MODEL = 'embedding_model'
export const META_VECTOR_DIMS = 'vector_dims'

/** Matryoshka-truncated storage dimension for embeddinggemma-2. */
export const VECTOR_DIMS = 256

export type EmbeddingStatus = 'complete' | 'partial'

export interface ChunkRow {
  id: number
  session_id: string
  parent_id: string | null
  kind: string
  text: string
  text_hash: string
  embedding_status: EmbeddingStatus
  embedding_model: string | null
  dims: number | null
}

export const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  git_branch TEXT,
  cwd TEXT,
  started_at TEXT,
  ended_at TEXT,
  build_epoch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  embedding_status TEXT NOT NULL DEFAULT 'partial',
  embedding_model TEXT,
  dims INTEGER
);
CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(text_hash);
CREATE UNIQUE INDEX IF NOT EXISTS chunks_identity ON chunks(session_id, parent_id, text_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO fts_chunks(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO fts_chunks(fts_chunks, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO fts_chunks(fts_chunks, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO fts_chunks(rowid, text) VALUES (new.id, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks_tri USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai_tri AFTER INSERT ON chunks BEGIN
  INSERT INTO fts_chunks_tri(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad_tri AFTER DELETE ON chunks BEGIN
  INSERT INTO fts_chunks_tri(fts_chunks_tri, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au_tri AFTER UPDATE ON chunks BEGIN
  INSERT INTO fts_chunks_tri(fts_chunks_tri, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO fts_chunks_tri(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  props TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  props TEXT
);
CREATE INDEX IF NOT EXISTS edges_from_type ON edges(from_id, type);
CREATE INDEX IF NOT EXISTS edges_to_type ON edges(to_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS edges_identity ON edges(from_id, to_id, type);

CREATE TABLE IF NOT EXISTS ingest_progress (
  session_id TEXT PRIMARY KEY,
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
`

export function vecSchemaSql(dims: number = VECTOR_DIMS): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(id INTEGER PRIMARY KEY, embedding float[${dims}] distance_metric=cosine);`
}

// ---------------------------------------------------------------------------
// Graph extraction (pure)
// ---------------------------------------------------------------------------

export type GraphNodeKind = 'session' | 'turn' | 'agent' | 'tool' | 'tool_result' | 'pr' | 'file' | 'background_task'

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  props?: Record<string, unknown>
}

export interface GraphEdge {
  from: string
  to: string
  type: string
  props?: Record<string, unknown>
}

/** Minimal structural view of a built item; avoids importing session-index types. */
export interface GraphItem {
  k: string
  name?: string
  input?: unknown
  result?: string
  agentId?: string
  subagentType?: string
  description?: string
  meta?: Record<string, unknown>
  ts?: string
}

export interface GraphItemContext {
  sessionId: string
  /** Jump id the viewer resolves, e.g. `t<turn>:<item>` or `a:<agentId>`. */
  parentId: string
}

export function graphNodeId(kind: GraphNodeKind, key: string): string {
  return `${kind}:${key}`
}

export interface GraphNodeIdParts {
  kind: string
  sessionId: string
  key: string
}

/** Parses an item node id (`tool:<sessionId>:<parentId>` / `agent:<sessionId>:<parentId>`). */
export function parseGraphNodeId(id: string): GraphNodeIdParts | null {
  const first = id.indexOf(':')
  if (first < 0) return null
  const kind = id.slice(0, first)
  const rest = id.slice(first + 1)
  const second = rest.indexOf(':')
  if (second < 0) return null
  return { kind, sessionId: rest.slice(0, second), key: rest.slice(second + 1) }
}

const FILE_OP_BY_TOOL: Record<string, 'read' | 'edit' | 'write'> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
}

export function extractFileOps(item: GraphItem): Array<{ path: string; op: 'read' | 'edit' | 'write' }> {
  const input = item.input as Record<string, unknown> | undefined
  if (!item.name || !input || typeof input !== 'object') return []
  const rawPath = input.file_path ?? input.path ?? input.notebook_path
  if (typeof rawPath !== 'string' || !rawPath) return []
  const op = FILE_OP_BY_TOOL[item.name]
  if (!op) return []
  return [{ path: rawPath, op }]
}

const PR_URL_RE = /https?:\/\/[^\s)]*\/pull\/(\d+)/g
const PR_REPO_RE = /github\.com\/([^/\s)]+\/[^/\s)]+)\/pull\/(\d+)/

export function extractPullRequests(item: GraphItem): Array<{ repo: string; number: string }> {
  const haystack = [item.result, typeof item.input === 'object' ? JSON.stringify(item.input) : '', item.description]
    .filter(Boolean)
    .join('\n')
  const found: Array<{ repo: string; number: string }> = []
  for (const match of haystack.matchAll(PR_URL_RE)) {
    const repoMatch = haystack.slice(Math.max(0, match.index - 60), match.index + match[0].length).match(PR_REPO_RE)
    found.push({ repo: repoMatch?.[1] ?? 'unknown', number: match[1] })
  }
  return found
}

/**
 * Extract the nodes and edges a single item contributes. `parentId` is the
 * viewer jump target; the item's tool/agent node id derives from it so a graph
 * hit resolves back to the transcript.
 */
export function extractItemGraph(item: GraphItem, context: GraphItemContext): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const sessionNode = graphNodeId('session', context.sessionId)
  const nodeKind: GraphNodeKind = item.k === 'agent' ? 'agent' : 'tool'
  const itemNode = graphNodeId(nodeKind, `${context.sessionId}:${context.parentId}`)
  nodes.push({ id: itemNode, kind: nodeKind, props: { name: item.name, kind: item.k } })
  edges.push({ from: sessionNode, to: itemNode, type: 'has' })

  if (item.k === 'agent' && item.agentId) {
    const agentNode = graphNodeId('agent', item.agentId)
    nodes.push({ id: agentNode, kind: 'agent', props: { subagentType: item.subagentType, description: item.description } })
    edges.push({ from: itemNode, to: agentNode, type: 'spawns' })
  }

  if (item.name === 'tool_result') {
    // Orphaned result (compaction) — provenance flag, never a fake tool.
    nodes.push({ id: itemNode, kind: 'tool_result', props: { orphaned: true } })
    return { nodes, edges }
  }

  const fileOps = extractFileOps(item)
  for (const { path, op } of fileOps) {
    const fileNode = graphNodeId('file', path)
    nodes.push({ id: fileNode, kind: 'file', props: { path } })
    edges.push({ from: itemNode, to: fileNode, type: op })
  }
  // Co-change: two distinct files touched by the same tool call (e.g. MultiEdit).
  const distinct = [...new Set(fileOps.map((f) => f.path))]
  for (let i = 0; i < distinct.length; i += 1) {
    for (let j = i + 1; j < distinct.length; j += 1) {
      edges.push({ from: graphNodeId('file', distinct[i]), to: graphNodeId('file', distinct[j]), type: 'co_change' })
    }
  }

  for (const pr of extractPullRequests(item)) {
    const prNode = graphNodeId('pr', `${pr.repo}#${pr.number}`)
    nodes.push({ id: prNode, kind: 'pr', props: pr })
    edges.push({ from: sessionNode, to: prNode, type: 'references' })
  }

  return { nodes, edges }
}

export function dedupeGraph(nodes: GraphNode[], edges: GraphEdge[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>()
  for (const node of nodes) if (!nodeMap.has(node.id)) nodeMap.set(node.id, node)
  const edgeKeys = new Set<string>()
  const dedupedEdges: GraphEdge[] = []
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.type}`
    if (edgeKeys.has(key)) continue
    edgeKeys.add(key)
    dedupedEdges.push(edge)
  }
  return { nodes: [...nodeMap.values()], edges: dedupedEdges }
}

export function extractSessionGraph(sessionId: string, items: Array<{ item: GraphItem; parentId: string }>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [{ id: graphNodeId('session', sessionId), kind: 'session', props: { sessionId } }]
  const edges: GraphEdge[] = []
  for (const { item, parentId } of items) {
    const extracted = extractItemGraph(item, { sessionId, parentId })
    nodes.push(...extracted.nodes)
    edges.push(...extracted.edges)
  }
  return dedupeGraph(nodes, edges)
}

