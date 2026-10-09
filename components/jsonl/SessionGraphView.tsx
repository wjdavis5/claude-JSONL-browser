'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { computeLayout, nodeViewTarget } from '@/lib/jsonl/graph-layout'
import { fetchSessionGraph, type SessionGraphView as GraphData } from '@/lib/jsonl/session-index-client'

const KIND_COLORS: Record<string, string> = {
  session: '#a7c080',
  agent: '#83c092',
  tool: '#7fbbb3',
  file: '#dbbc7f',
  pr: '#d699b6',
  tool_result: '#e67e80',
  unknown: '#859289',
}

export function SessionGraphView({ sessionId, onOpenNode }: { sessionId: string; onOpenNode?: (nodeId: string) => void }) {
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setHidden(new Set())
    fetchSessionGraph(sessionId)
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoading(false)
        }
      })
      .catch(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const kinds = useMemo(() => (data ? [...new Set(data.nodes.map((node) => node.kind))].sort() : []), [data])

  const layout = useMemo(() => {
    if (!data) return null
    const nodes = data.nodes.filter((node) => !hidden.has(node.kind))
    const keep = new Set(nodes.map((node) => node.id))
    const edges = data.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to))
    return computeLayout(nodes, edges, { width: 900, height: 620, seed: 7 })
  }, [data, hidden])

  const position = useMemo(() => new Map((layout?.nodes ?? []).map((node) => [node.id, node])), [layout])
  const visibleEdges = useMemo(
    () => (data ? data.edges.filter((edge) => position.has(edge.from) && position.has(edge.to)) : []),
    [data, position],
  )

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-everforest-grey1 text-sm p-4">
        <Loader2 className="w-4 h-4 animate-spin" />Loading graph…
      </div>
    )
  }
  if (!data) {
    return (
      <div className="p-4 text-sm text-everforest-grey1">
        No graph database for this session. Build it with{' '}
        <code className="text-everforest-blue">npm run index -- &lt;session-dir&gt;</code>.
      </div>
    )
  }
  if (!layout || layout.nodes.length === 0) {
    return <div className="p-4 text-sm text-everforest-grey1">No nodes to display.</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-everforest-grey1">{data.nodes.length} nodes · {data.edges.length} edges{data.truncated ? ' (capped)' : ''}</span>
        <span className="flex-1" />
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() =>
              setHidden((previous) => {
                const next = new Set(previous)
                if (next.has(kind)) next.delete(kind)
                else next.add(kind)
                return next
              })
            }
            className={cn(
              'px-2 py-0.5 rounded border transition-opacity',
              hidden.has(kind) ? 'opacity-40 border-everforest-bg4' : 'border-everforest-bg4',
            )}
          >
            <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: KIND_COLORS[kind] ?? KIND_COLORS.unknown }} />
            {kind}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-everforest-bg4 bg-everforest-bg0 overflow-hidden">
        <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="w-full h-[620px]">
          {visibleEdges.map((edge, i) => {
            const from = position.get(edge.from)
            const to = position.get(edge.to)
            if (!from || !to) return null
            return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#4f585e" strokeWidth={0.6} />
          })}
          {layout.nodes.map((node) => {
            const radius = 4 + Math.min(10, node.degree)
            const target = nodeViewTarget(node.id)
            return (
              <g
                key={node.id}
                transform={`translate(${node.x},${node.y})`}
                onClick={() => target && onOpenNode?.(node.id)}
                className={target ? 'cursor-pointer' : undefined}
              >
                <circle r={radius} fill={KIND_COLORS[node.kind] ?? KIND_COLORS.unknown} fillOpacity={0.85} stroke="#2d353b" strokeWidth={0.5} />
                {node.degree > 3 && (
                  <text x={radius + 2} y={3} fontSize={9} fill="#9da9a0">
                    {node.label.length > 28 ? `${node.label.slice(0, 28)}…` : node.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {data.duplicates.length > 0 && (
        <div className="rounded-lg border border-everforest-yellow/30 bg-everforest-bg1/60 p-3">
          <div className="text-xs text-everforest-yellow mb-1">Duplicate-work rail · {data.duplicates.length} file{data.duplicates.length === 1 ? '' : 's'} touched by more than one tool</div>
          <div className="space-y-1">
            {data.duplicates.slice(0, 20).map((group) => (
              <div key={group.file} className="text-xs text-everforest-grey2 truncate">
                <code className="text-everforest-aqua">{group.file}</code> · {group.tools.length} touches
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
