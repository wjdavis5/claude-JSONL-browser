import type {
  AgentBody,
  SessionCatalog,
  SessionCatalogEntry,
  SessionItem,
  SessionManifest,
  Turn,
  TurnShard,
} from './session-index'

const BASE = '/sessions'

export interface SearchDoc {
  id: string
  kind: 'turn' | 'agent'
  turn?: number
  item?: number
  agent?: string
  label: string
  text: string
}

export interface SearchPayload {
  version: number
  docs: SearchDoc[]
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`)
  return (await response.json()) as T
}

export function fetchCatalog(): Promise<SessionCatalog> {
  return getJson<SessionCatalog>(`${BASE}/index.json`)
}

export function fetchManifest(id: string): Promise<SessionManifest> {
  return getJson<SessionManifest>(`${BASE}/${id}/manifest.json`)
}

export function fetchSearch(id: string): Promise<SearchPayload> {
  return getJson<SearchPayload>(`${BASE}/${id}/search.json`)
}

export function fetchTurnShard(id: string, shard: number): Promise<TurnShard> {
  return getJson<TurnShard>(`${BASE}/${id}/turns/${shard}.json`)
}

export function fetchAgent(id: string, agentId: string): Promise<AgentBody> {
  return getJson<AgentBody>(`${BASE}/${id}/agents/${agentId}.json`)
}

export interface HybridSearchHit {
  id: number
  parentId: string | null
  sessionId: string
  kind: string
  text: string
  score: number
  legs: string[]
}

/**
 * Server-side hybrid retrieval. Returns `null` when the API is unavailable
 * (static host, no database, or a request failure) so the caller falls back to
 * the static lexical search.
 */
export async function fetchHybridSearch(
  sessionId: string,
  query: string,
  options: { k?: number; graph?: boolean } = {},
): Promise<HybridSearchHit[] | null> {
  const params = new URLSearchParams({ sessionId, q: query, k: String(options.k ?? 20) })
  if (options.graph) params.set('graph', '1')
  try {
    const response = await fetch(`/api/session/search?${params.toString()}`)
    if (!response.ok) return null
    const json = (await response.json()) as { hits?: HybridSearchHit[] }
    // Empty hybrid results fall back to the static scan rather than hiding it.
    return json.hits && json.hits.length > 0 ? json.hits : null
  } catch {
    return null
  }
}

export function shardForTurn(turnIndex: number, shardSize: number): number {
  return Math.floor(turnIndex / Math.max(1, shardSize))
}

export function formatDuration(ms?: number): string {
  if (!ms) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function formatCost(usd?: number): string {
  if (!usd) return '—'
  return `$${usd.toFixed(2)}`
}

export function formatTokens(value?: number): string {
  if (!value) return '0'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function formatTimestamp(ts?: string): string {
  if (!ts) return ''
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function relativeTime(ts?: string): string {
  if (!ts) return ''
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  const diff = Date.now() - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function sessionLabel(entry: SessionCatalogEntry): string {
  return entry.title || entry.id.slice(0, 12)
}

export function itemText(item: SessionItem): string {
  if (item.text) return item.text
  if (item.result) return item.result
  return ''
}

export function toolSummary(item: SessionItem): string {
  const input = item.input
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']) {
      const value = record[key]
      if (typeof value === 'string' && value) return value.replace(/\s+/g, ' ').slice(0, 160)
    }
  }
  if (item.result) return item.result.replace(/\s+/g, ' ').slice(0, 160)
  return ''
}

export function turnContains(turn: Turn, needle: string): boolean {
  const lower = needle.toLowerCase()
  return turn.items.some((item) => {
    const haystack = [item.text, item.result, item.description, safeString(item.input)].join('\n').toLowerCase()
    return haystack.includes(lower)
  })
}

function safeString(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return ''
  }
}
