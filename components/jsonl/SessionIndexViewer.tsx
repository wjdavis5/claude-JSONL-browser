'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bot,
  Clock,
  Coins,
  Cpu,
  FolderOpen,
  GitBranch,
  Hash,
  Layers,
  ListTree,
  Activity,
  Share2,
  Loader2,
  MessageSquare,
  Search,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentBody, SessionManifest, Turn } from '@/lib/jsonl/session-index'
import {
  fetchAgent,
  fetchCatalog,
  fetchHybridSearch,
  fetchIndexStatus,
  fetchManifest,
  fetchSearch,
  fetchTurnShard,
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
  shardForTurn,
  type HybridSearchHit,
  type IndexStatus,
  type SearchDoc,
  type SearchPayload,
} from '@/lib/jsonl/session-index-client'
import { Highlight, SessionItems } from '@/components/jsonl/SessionBlocks'
import { SessionGraphView } from '@/components/jsonl/SessionGraphView'
import { SessionTimeline } from '@/components/jsonl/SessionTimeline'
import { nodeViewTarget } from '@/lib/jsonl/graph-layout'
import { parseParentId } from '@/lib/jsonl/session-jump'

type View = { kind: 'turn'; i: number } | { kind: 'agent'; id: string }
type Tab = 'turns' | 'agents' | 'timeline' | 'graph' | 'search'

export default function SessionIndexViewer({ initialSessionId }: { initialSessionId?: string }) {
  const [catalog, setCatalog] = useState<{ sessions: Array<{ id: string; title?: string; counts: { turns: number; toolCalls: number; agents: number }; sessionStart?: string; models: string[]; bytes: number }> } | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId || null)
  const [manifest, setManifest] = useState<SessionManifest | null>(null)
  const [loadingManifest, setLoadingManifest] = useState(false)

  const [tab, setTab] = useState<Tab>('turns')
  const [stack, setStack] = useState<View[]>([])
  const [turns, setTurns] = useState<Record<number, Turn>>({})
  const [agents, setAgents] = useState<Record<string, AgentBody>>({})
  const [loadingView, setLoadingView] = useState(false)

  const [search, setSearch] = useState<SearchPayload | null>(null)
  const [loadingSearch, setLoadingSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [agentFilter, setAgentFilter] = useState('')
  const [highlight, setHighlight] = useState<{ turn: number; item: number } | null>(null)
  const [hybridHits, setHybridHits] = useState<HybridSearchHit[] | null>(null)
  const [hybridActive, setHybridActive] = useState(false)
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const lastScrolledTurn = useRef<number | null>(null)

  const current = stack.length > 0 ? stack[stack.length - 1] : null
  const currentTurn = current?.kind === 'turn' ? turns[current.i] : null
  const currentAgent = current?.kind === 'agent' ? agents[current.id] : null

  // --- Catalog ---
  useEffect(() => {
    let cancelled = false
    fetchCatalog()
      .then((data) => {
        if (cancelled) return
        setCatalog(data)
        if (!sessionId && data.sessions.length > 0) setSessionId(data.sessions[0].id)
      })
      .catch((error) => !cancelled && setCatalogError(error instanceof Error ? error.message : 'Failed to load catalog'))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Manifest ---
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setLoadingManifest(true)
    setManifest(null)
    setTurns({})
    setAgents({})
    setStack([])
    setSearch(null)
    setQuery('')
    fetchManifest(sessionId)
      .then((data) => {
        if (cancelled) return
        setManifest(data)
        setStack(parseHash(window.location.hash, data) || [{ kind: 'turn', i: 0 }])
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoadingManifest(false))
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Poll live ingest progress while a session is selected.
  useEffect(() => {
    if (!sessionId) {
      setIndexStatus(null)
      return
    }
    let cancelled = false
    const poll = () => {
      void fetchIndexStatus(sessionId).then((status) => {
        if (!cancelled) setIndexStatus(status)
      })
    }
    poll()
    const timer = window.setInterval(poll, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId])

  const ensureTurn = useCallback(
    async (index: number): Promise<Turn | undefined> => {
      if (!sessionId || !manifest) return undefined
      if (turns[index]) return turns[index]
      const shard = shardForTurn(index, manifest.turnShardSize)
      const data = await fetchTurnShard(sessionId, shard)
      setTurns((previous) => {
        const next = { ...previous }
        for (const turn of data.turns) next[turn.i] = turn
        return next
      })
      return data.turns.find((turn) => turn.i === index)
    },
    [sessionId, manifest, turns],
  )

  const ensureSearch = useCallback(async () => {
    if (!sessionId || search || loadingSearch) return
    setLoadingSearch(true)
    try {
      const data = await fetchSearch(sessionId)
      setSearch(data)
    } finally {
      setLoadingSearch(false)
    }
  }, [sessionId, search, loadingSearch])

  const openView = useCallback((view: View) => {
    if (view.kind === 'turn') setStack([view])
    else setStack((previous) => [...previous, view])
  }, [])

  // Load the currently selected view (turn body or agent transcript).
  useEffect(() => {
    if (!current || !sessionId || !manifest) return
    let cancelled = false
    if (current.kind === 'turn') {
      if (turns[current.i]) return
      setLoadingView(true)
      ensureTurn(current.i)
        .catch(() => {})
        .finally(() => !cancelled && setLoadingView(false))
    } else {
      if (agents[current.id]) return
      setLoadingView(true)
      fetchAgent(sessionId, current.id)
        .then((body) => !cancelled && setAgents((previous) => ({ ...previous, [body.id]: body })))
        .catch(() => {})
        .finally(() => !cancelled && setLoadingView(false))
    }
    return () => {
      cancelled = true
    }
  }, [current, sessionId, manifest, turns, agents, ensureTurn])

  // Preload the next turn for snappy navigation.
  useEffect(() => {
    if (!current || current.kind !== 'turn' || !manifest) return
    if (current.i + 1 < manifest.turns.length) void ensureTurn(current.i + 1).catch(() => {})
  }, [current, manifest, ensureTurn])

  // Scroll to top when the selected turn changes (but not when data reloads).
  useEffect(() => {
    if (!current || current.kind !== 'turn') return
    if (lastScrolledTurn.current === current.i || !turns[current.i]) return
    lastScrolledTurn.current = current.i
    scrollRef.current?.scrollTo({ top: 0 })
  }, [current, turns])

  // Reflect the current view in the URL hash for deep-linking.
  useEffect(() => {
    if (!manifest || stack.length === 0) return
    const view = stack[stack.length - 1]
    const hash = view.kind === 'turn' ? `#turn/${view.i}` : `#agent/${view.id}`
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash)
  }, [stack, manifest])

  const goTurn = useCallback(
    (index: number) => {
      if (!manifest) return
      const clamped = Math.max(0, Math.min(manifest.turns.length - 1, index))
      setHighlight(null)
      void openView({ kind: 'turn', i: clamped })
    },
    [manifest, openView],
  )

  // Keyboard navigation between turns.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'j' || event.key === 'ArrowDown') {
        if (current?.kind === 'turn') goTurn(current.i + 1)
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        if (current?.kind === 'turn') goTurn(current.i - 1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [current, goTurn])

  const searchResults = useMemo(() => {
    if (!search || !query.trim()) return []
    const needle = query.trim().toLowerCase()
    const results: Array<{ doc: SearchDoc; index: number }> = []
    for (let i = 0; i < search.docs.length; i += 1) {
      const doc = search.docs[i]
      if (doc.text.toLowerCase().includes(needle) || doc.label.toLowerCase().includes(needle)) {
        results.push({ doc, index: i })
        if (results.length >= 300) break
      }
    }
    return results
  }, [search, query])

  // Prefer the server-side hybrid API; fall back to the static lexical scan.
  useEffect(() => {
    if (!sessionId || !query.trim()) {
      setHybridHits(null)
      setHybridActive(false)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetchHybridSearch(sessionId, query, { graph: true, signal: controller.signal }).then((hits) => {
        if (cancelled || controller.signal.aborted) return
        if (hits === null) {
          setHybridActive(false)
          setHybridHits(null)
        } else {
          setHybridHits(hits)
          setHybridActive(true)
        }
      })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, query])

  const filteredAgents = useMemo(() => {
    if (!manifest) return []
    const needle = agentFilter.trim().toLowerCase()
    if (!needle) return manifest.agents
    return manifest.agents.filter((agent) =>
      [agent.description, agent.subagentType, agent.model, agent.task, agent.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [manifest, agentFilter])

  const jumpToResult = useCallback(
    (doc: SearchDoc) => {
      if (doc.kind === 'turn' && doc.turn !== undefined) {
        setHighlight({ turn: doc.turn, item: doc.item ?? 0 })
        void openView({ kind: 'turn', i: doc.turn })
      } else if (doc.kind === 'agent' && doc.agent) {
        void openView({ kind: 'agent', id: doc.agent })
      }
    },
    [openView],
  )

  const jumpToHit = useCallback(
    (hit: HybridSearchHit) => {
      const parsed = hit.parentId ? parseParentId(hit.parentId) : null
      if (!parsed) return
      if ('agent' in parsed) {
        void openView({ kind: 'agent', id: parsed.agent })
        return
      }
      setHighlight({ turn: parsed.turn, item: parsed.item })
      void openView({ kind: 'turn', i: parsed.turn })
    },
    [openView],
  )

  const openGraphNode = useCallback(
    (nodeId: string) => {
      const target = nodeViewTarget(nodeId)
      const parsed = target ? parseParentId(target) : null
      if (!parsed) return
      setTab('turns')
      if ('agent' in parsed) {
        void openView({ kind: 'agent', id: parsed.agent })
        return
      }
      setHighlight({ turn: parsed.turn, item: parsed.item })
      void openView({ kind: 'turn', i: parsed.turn })
    },
    [openView],
  )

  // ---- Render ----

  if (catalogError) {
    return (
      <CenteredMessage
        title="No indexed sessions found"
        body={
          <>
            <p>{catalogError}</p>
            <p className="mt-2 text-everforest-grey1">
              Build one with{' '}
              <code className="text-everforest-blue">npm run index -- &lt;session-dir-or.jsonl&gt;</code>.
            </p>
          </>
        }
      />
    )
  }

  if (!catalog) {
    return <CenteredMessage title="Loading sessions…" body={<Loader2 className="w-5 h-5 animate-spin" />} />
  }

  return (
    <div className="h-screen bg-everforest-bg0 flex overflow-hidden">
      {/* Sidebar */}
      <aside className="w-[340px] min-w-[340px] bg-everforest-bg-dim border-r border-everforest-bg4 flex flex-col">
        <div className="p-3 border-b border-everforest-bg4 space-y-2">
          {catalog.sessions.length > 1 && (
            <select
              value={sessionId || ''}
              onChange={(event) => setSessionId(event.target.value)}
              className="w-full px-2 py-1.5 bg-everforest-bg0 border border-everforest-bg4 rounded-md text-everforest-fg text-sm outline-none focus:border-everforest-green"
            >
              {catalog.sessions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title || entry.id.slice(0, 12)}
                </option>
              ))}
            </select>
          )}

          {manifest ? (
            <div>
              <h2 className="text-sm font-medium text-everforest-fg truncate">{manifest.title || manifest.id.slice(0, 12)}</h2>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-everforest-grey1">
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(Date.parse(manifest.sessionEnd || '') - Date.parse(manifest.sessionStart || ''))}</span>
                <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{manifest.counts.userPrompts} prompts</span>
                <span className="flex items-center gap-1"><Wrench className="w-3 h-3" />{manifest.counts.toolCalls} tools</span>
                <span className="flex items-center gap-1"><Bot className="w-3 h-3" />{manifest.counts.agents} agents</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-everforest-grey1">
                {manifest.gitBranch && <span className="flex items-center gap-1"><GitBranch className="w-3 h-3" />{manifest.gitBranch}</span>}
                {manifest.cost?.totalCostUSD ? <span className="flex items-center gap-1"><Coins className="w-3 h-3" />{formatCost(manifest.cost.totalCostUSD)}</span> : null}
                {manifest.models.filter((m) => m !== '<synthetic>').map((model) => (
                  <span key={model} className="flex items-center gap-1"><Cpu className="w-3 h-3" />{model}</span>
                ))}
              </div>
              {indexStatus && indexStatus.total > 0 && indexStatus.processed < indexStatus.total && (
                <div className="mt-2" title="Indexing in progress">
                  <div className="h-1 rounded bg-everforest-bg2 overflow-hidden">
                    <div
                      className="h-full bg-everforest-green transition-all duration-500"
                      style={{ width: `${Math.round((indexStatus.processed / indexStatus.total) * 100)}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-everforest-grey1">
                    Indexing… {Math.round((indexStatus.processed / indexStatus.total) * 100)}%
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-everforest-grey1 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
          )}
        </div>

        {/* Tabs */}
        <div className="p-2 grid grid-cols-5 gap-1 border-b border-everforest-bg4">
          {(['turns', 'agents', 'timeline', 'graph', 'search'] as Tab[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setTab(value)
                if (value === 'search') void ensureSearch()
              }}
              className={cn(
                'py-1.5 rounded-md text-xs font-medium capitalize flex items-center justify-center gap-1 transition-colors',
                tab === value ? 'bg-everforest-bg3 text-everforest-fg' : 'text-everforest-grey1 hover:bg-everforest-bg1',
              )}
            >
              {value === 'turns' ? <ListTree className="w-3.5 h-3.5" /> : value === 'agents' ? <Bot className="w-3.5 h-3.5" /> : value === 'timeline' ? <Activity className="w-3.5 h-3.5" /> : value === 'graph' ? <Share2 className="w-3.5 h-3.5" /> : <Search className="w-3.5 h-3.5" />}
              {value}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {!manifest ? null : tab === 'turns' ? (
            <div className="p-1.5">
              {manifest.turns.map((turn) => {
                const active = current?.kind === 'turn' && current.i === turn.i
                return (
                  <button
                    key={turn.i}
                    type="button"
                    onClick={() => goTurn(turn.i)}
                    className={cn(
                      'w-full text-left px-2.5 py-2 rounded-md mb-0.5 border transition-colors',
                      active ? 'bg-everforest-bg2 border-everforest-green/50' : 'border-transparent hover:bg-everforest-bg1',
                    )}
                  >
                    <div className="flex items-center gap-2 text-[11px] text-everforest-grey1 mb-0.5">
                      <span className="font-mono">{String(turn.i).padStart(3, '0')}</span>
                      {turn.kind === 'prompt' ? <span className="text-everforest-green">prompt</span> : <span className="text-everforest-yellow">{turn.kind}</span>}
                      {turn.ts && <span className="ml-auto">{formatTimestamp(turn.ts)}</span>}
                    </div>
                    <div className="text-xs text-everforest-fg line-clamp-2">{turn.preview || '(no prompt)'}</div>
                    <div className="mt-1 flex gap-2 text-[10px] text-everforest-grey0">
                      {turn.toolCount > 0 && <span>{turn.toolCount} tools</span>}
                      {turn.agentCount > 0 && <span>{turn.agentCount} agents</span>}
                      {turn.thinkCount > 0 && <span>{turn.thinkCount} think</span>}
                      {turn.tokens && <span>{formatTokens(turn.tokens.out)} tok</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          ) : tab === 'agents' ? (
            <div className="p-1.5">
              <input
                type="text"
                value={agentFilter}
                onChange={(event) => setAgentFilter(event.target.value)}
                placeholder={`Filter ${manifest.agents.length} agents`}
                className="w-full mb-1.5 px-2 py-1.5 bg-everforest-bg0 border border-everforest-bg4 rounded-md text-everforest-fg text-xs outline-none focus:border-everforest-green"
              />
              {filteredAgents.slice(0, 400).map((agent) => {
                const active = current?.kind === 'agent' && current.id === agent.id
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => void openView({ kind: 'agent', id: agent.id })}
                    className={cn(
                      'w-full text-left px-2.5 py-2 rounded-md mb-0.5 border transition-colors',
                      active ? 'bg-everforest-bg2 border-everforest-aqua/50' : 'border-transparent hover:bg-everforest-bg1',
                    )}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <Bot className={cn('w-3.5 h-3.5 flex-shrink-0', agent.parentId ? 'text-everforest-grey0' : 'text-everforest-aqua')} />
                      <span className="text-xs text-everforest-fg truncate flex-1">{agent.description || agent.subagentType || agent.id}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-everforest-grey0">
                      {agent.subagentType && <span>{agent.subagentType}</span>}
                      {agent.status && <span className={agent.status === 'completed' ? 'text-everforest-green' : 'text-everforest-yellow'}>{agent.status}</span>}
                      {agent.itemCount > 0 && <span>{agent.itemCount} items</span>}
                      {agent.tsStart && <span className="ml-auto">{formatTimestamp(agent.tsStart)}</span>}
                    </div>
                  </button>
                )
              })}
              {filteredAgents.length > 400 && (
                <div className="p-2 text-[11px] text-everforest-grey1 text-center">Showing 400 of {filteredAgents.length}. Refine the filter.</div>
              )}
            </div>
          ) : (
            <div className="p-1.5">
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search this session…"
                autoFocus
                className="w-full mb-1.5 px-2 py-1.5 bg-everforest-bg0 border border-everforest-bg4 rounded-md text-everforest-fg text-xs outline-none focus:border-everforest-green"
              />
              {loadingSearch && <div className="text-xs text-everforest-grey1 flex items-center gap-2 px-1 py-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Building search index…</div>}
              {hybridActive && hybridHits ? (
                <>
                  <div className="text-[11px] text-everforest-grey1 px-1 pb-1">
                    {hybridHits.length} ranked result{hybridHits.length === 1 ? '' : 's'} · hybrid
                  </div>
                  {hybridHits.map((hit) => (
                    <button
                      key={hit.id}
                      type="button"
                      onClick={() => jumpToHit(hit)}
                      className="w-full text-left px-2.5 py-2 rounded-md mb-0.5 border border-transparent hover:bg-everforest-bg1 transition-colors"
                    >
                      <div className="text-[11px] text-everforest-blue mb-0.5">
                        {hit.kind}
                        {hit.legs.length > 0 && <span className="text-everforest-grey1"> · {hit.legs.join('+')}</span>}
                      </div>
                      <div className="text-xs text-everforest-grey2 line-clamp-2">
                        <Highlight text={snippet(hit.text, query)} query={query} />
                      </div>
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {search && query.trim() && (
                    <div className="text-[11px] text-everforest-grey1 px-1 pb-1">
                      {searchResults.length}
                      {searchResults.length >= 300 ? '+' : ''} result{searchResults.length === 1 ? '' : 's'}
                    </div>
                  )}
                  {searchResults.map(({ doc, index }) => (
                    <button
                      key={`${doc.id}-${index}`}
                      type="button"
                      onClick={() => jumpToResult(doc)}
                      className="w-full text-left px-2.5 py-2 rounded-md mb-0.5 border border-transparent hover:bg-everforest-bg1 transition-colors"
                    >
                      <div className="text-[11px] text-everforest-blue mb-0.5">{doc.label}</div>
                      <div className="text-xs text-everforest-grey2 line-clamp-2">
                        <Highlight text={snippet(doc.text, query)} query={query} />
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <section className="flex-1 flex flex-col overflow-hidden">
        <header className="px-4 py-2.5 border-b border-everforest-bg4 bg-everforest-bg1 flex items-center gap-3">
          {stack.length > 1 && (
            <button
              type="button"
              onClick={() => setStack((previous) => previous.slice(0, -1))}
              className="p-1.5 rounded hover:bg-everforest-bg2 text-everforest-grey1"
              aria-label="Back"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {currentTurn && (
            <>
              <Hash className="w-4 h-4 text-everforest-green" />
              <span className="text-sm text-everforest-fg">Turn {currentTurn.i}</span>
              {currentTurn.ts && <span className="text-xs text-everforest-grey1">{formatTimestamp(currentTurn.ts)}</span>}
              <span className="flex-1" />
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => goTurn(currentTurn.i - 1)} className="p-1.5 rounded hover:bg-everforest-bg2 text-everforest-grey1" aria-label="Previous turn">‹</button>
                <span className="text-xs text-everforest-grey1 px-1">{currentTurn.i + 1}/{manifest?.turns.length || 0}</span>
                <button type="button" onClick={() => goTurn(currentTurn.i + 1)} className="p-1.5 rounded hover:bg-everforest-bg2 text-everforest-grey1" aria-label="Next turn">›</button>
              </div>
            </>
          )}
          {currentAgent && (
            <>
              <Bot className="w-4 h-4 text-everforest-aqua" />
              <span className="text-sm text-everforest-fg truncate">{currentAgent.header.description || currentAgent.header.subagentType || currentAgent.id}</span>
              <span className="text-xs text-everforest-grey1 font-mono">{currentAgent.id}</span>
              <span className="flex-1" />
              {currentAgent.header.model && <span className="text-[11px] text-everforest-grey1">{currentAgent.header.model}</span>}
              {currentAgent.header.status && <span className="text-[11px] text-everforest-grey1">{currentAgent.header.status}</span>}
            </>
          )}
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar p-4">
          {loadingView && (
            <div className="flex items-center gap-2 text-everforest-grey1 text-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
          )}

          {tab === 'timeline' && manifest && (
            <div className="max-w-6xl mx-auto">
              <SessionTimeline
                manifest={manifest}
                onOpenTurn={(i) => {
                  setTab('turns')
                  goTurn(i)
                }}
                onOpenAgent={(id) => {
                  setTab('turns')
                  void openView({ kind: 'agent', id })
                }}
              />
            </div>
          )}

          {tab === 'graph' && sessionId && (
            <div className="max-w-5xl mx-auto">
              <SessionGraphView sessionId={sessionId} onOpenNode={openGraphNode} />
            </div>
          )}

          {tab !== 'graph' && tab !== 'timeline' && !loadingView && currentTurn && (
            <TurnBody
              turn={currentTurn}
              query={query}
              highlightIndex={highlight?.turn === currentTurn.i ? highlight.item : undefined}
              onOpenAgent={(id) => void openView({ kind: 'agent', id })}
            />
          )}

          {tab !== 'graph' && tab !== 'timeline' && !loadingView && currentAgent && (
            <div className="space-y-3">
              <div className="rounded-lg border border-everforest-aqua/30 bg-everforest-bg1/60 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <Bot className="w-4 h-4 text-everforest-aqua" />
                  <span className="text-sm font-medium text-everforest-fg">Subagent transcript</span>
                  {currentAgent.header.subagentType && <span className="px-1.5 py-0.5 rounded bg-everforest-bg-blue text-everforest-blue text-[11px]">{currentAgent.header.subagentType}</span>}
                  {currentAgent.header.model && <span className="px-1.5 py-0.5 rounded bg-everforest-bg2 text-everforest-grey2 text-[11px]">{currentAgent.header.model}</span>}
                  {currentAgent.header.parentId && (
                    <button type="button" onClick={() => void openView({ kind: 'agent', id: currentAgent.header.parentId as string })} className="text-[11px] text-everforest-blue hover:underline">
                      parent: {currentAgent.header.parentId}
                    </button>
                  )}
                </div>
                {currentAgent.header.task && (
                  <pre className="whitespace-pre-wrap break-words font-sans text-xs text-everforest-grey2 max-h-40 overflow-auto custom-scrollbar">
                    <Highlight text={currentAgent.header.task} query={query} />
                  </pre>
                )}
                {Object.keys(currentAgent.header.tools).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(currentAgent.header.tools).sort((a, b) => b[1] - a[1]).map(([name, count]) => (
                      <span key={name} className="px-1.5 py-0.5 rounded bg-everforest-bg2 text-everforest-grey2 text-[10px]">{name} ×{count}</span>
                    ))}
                  </div>
                )}
              </div>
              <SessionItems items={currentAgent.items} query={query} onOpenAgent={(id) => void openView({ kind: 'agent', id })} />
            </div>
          )}

          {!loadingView && !currentTurn && !currentAgent && (
            <div className="h-full flex items-center justify-center text-everforest-grey1 text-sm">
              Select a turn, an agent, or search to begin.
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function TurnBody({
  turn,
  query,
  onOpenAgent,
  highlightIndex,
}: {
  turn: Turn
  query: string
  onOpenAgent: (id: string) => void
  highlightIndex?: number
}) {
  return (
    <div className="max-w-4xl mx-auto space-y-3">
      <div className="flex items-center gap-2 text-xs text-everforest-grey1">
        <Layers className="w-3.5 h-3.5" />
        <span>{turn.items.length} blocks</span>
        {turn.kind !== 'prompt' && <span className="px-1.5 py-0.5 rounded bg-everforest-bg2 text-everforest-grey2 text-[10px]">{turn.kind}</span>}
      </div>
      <SessionItems items={turn.items} query={query} onOpenAgent={onOpenAgent} highlightIndex={highlightIndex} />
    </div>
  )
}

function CenteredMessage({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="h-screen bg-everforest-bg0 flex items-center justify-center p-6">
      <div className="text-center max-w-md">
        <FolderOpen className="w-12 h-12 text-everforest-grey0 mx-auto mb-3" />
        <h1 className="text-lg text-everforest-fg mb-2">{title}</h1>
        <div className="text-sm text-everforest-grey1">{body}</div>
      </div>
    </div>
  )
}

function parseHash(hash: string, manifest: SessionManifest): View[] | null {
  const clean = hash.replace(/^#/, '')
  const [kind, value] = clean.split('/')
  if (kind === 'turn' && value !== undefined) {
    const index = Number(value)
    if (Number.isInteger(index) && index >= 0 && index < manifest.turns.length) return [{ kind: 'turn', i: index }]
  }
  if (kind === 'agent' && value) return [{ kind: 'agent', id: value }]
  return null
}

function snippet(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index === -1) return text.slice(0, 200)
  const start = Math.max(0, index - 80)
  const end = Math.min(text.length, index + query.length + 120)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
