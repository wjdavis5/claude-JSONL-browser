'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Minus, Plus, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { computeTimeLayout, nodeViewTarget, type TimeLayoutNode } from '@/lib/jsonl/graph-layout'
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

const BASE_W = 1400
const ROW_H = 120
const MIN_ZOOM = 1
const MAX_ZOOM = 4000

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function SessionGraphView({ sessionId, onOpenNode }: { sessionId: string; onOpenNode?: (nodeId: string) => void }) {
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)

  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setHidden(new Set())
    setSelected(null)
    setZoom(1)
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

  const times = useMemo(() => {
    const all = (data?.nodes ?? []).map((node) => node.ts).filter((ts): ts is number => typeof ts === 'number')
    const min = Math.min(...all)
    const max = Math.max(...all)
    return { t0: Number.isFinite(min) ? min : 0, t1: Number.isFinite(max) ? max : 1 }
  }, [data])

  const span = Math.max(1, times.t1 - times.t0)
  const pxPerMs = (BASE_W / span) * zoom

  const layout = useMemo(() => {
    if (!data) return null
    const nodes = data.nodes.filter((node) => !hidden.has(node.kind))
    return computeTimeLayout(nodes, { t0: times.t0, t1: times.t1, pxPerMs, rowH: ROW_H })
  }, [data, hidden, times.t0, times.t1, pxPerMs])

  const position = useMemo(() => new Map((layout?.nodes ?? []).map((node) => [node.id, node])), [layout])
  const visibleEdges = useMemo(
    () => (data ? data.edges.filter((edge) => position.has(edge.from) && position.has(edge.to)) : []),
    [data, position],
  )
  const nodeById = useMemo(() => new Map((layout?.nodes ?? []).map((node) => [node.id, node])), [layout])

  const neighborsOf = useMemo(() => {
    const map = new Map<string, TimeLayoutNode[]>()
    for (const edge of visibleEdges) {
      const a = nodeById.get(edge.from)
      const b = nodeById.get(edge.to)
      if (a && b) {
        if (!map.has(edge.from)) map.set(edge.from, [])
        if (!map.has(edge.to)) map.set(edge.to, [])
        map.get(edge.from)?.push(b)
        map.get(edge.to)?.push(a)
      }
    }
    return map
  }, [visibleEdges, nodeById])

  const highlight = useMemo(() => {
    const focus = selected ?? hovered
    if (!focus) return null
    return new Set<string>([focus, ...(neighborsOf.get(focus) ?? []).map((node) => node.id)])
  }, [selected, hovered, neighborsOf])

  const zoomAt = (factor: number, clientX?: number): void => {
    const el = scrollRef.current
    setZoom((current) => {
      const next = clamp(current * factor, MIN_ZOOM, MAX_ZOOM)
      if (el) {
        const rect = el.getBoundingClientRect()
        const px = clientX !== undefined ? clientX - rect.left : el.clientWidth / 2
        const cursorX = px + el.scrollLeft
        const timeAtCursor = times.t0 + (cursorX - 40) / ((BASE_W / span) * current)
        requestAnimationFrame(() => {
          el.scrollLeft = (timeAtCursor - times.t0) * ((BASE_W / span) * next) + 40 - px
        })
      }
      return next
    })
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !layout) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      event.preventDefault()
      zoomAt(event.deltaY < 0 ? 1.25 : 1 / 1.25, event.clientX)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, span, times.t0])

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

  const selectedNode = selected ? nodeById.get(selected) : undefined
  const openTarget = selected ? nodeViewTarget(selected) : null
  const secondsPerScreen = (span / zoom) / 1000

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-everforest-grey1">
          {data.nodes.length} nodes on a time axis · x = time · scroll to move, wheel to zoom the time scale (now ~{Math.round(secondsPerScreen / 60)} min across the view)
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => zoomAt(1.5)} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Zoom in"><Plus className="w-3.5 h-3.5" /></button>
        <button type="button" onClick={() => zoomAt(1 / 1.5)} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Zoom out"><Minus className="w-3.5 h-3.5" /></button>
        <button type="button" onClick={() => setZoom(1)} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Reset zoom"><RotateCcw className="w-3.5 h-3.5" /></button>
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
            className={cn('px-2 py-0.5 rounded border transition-opacity', hidden.has(kind) ? 'opacity-40 border-everforest-bg4' : 'border-everforest-bg4')}
          >
            <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: KIND_COLORS[kind] ?? KIND_COLORS.unknown }} />
            {kind}
          </button>
        ))}
      </div>

      <div className="flex rounded-lg border border-everforest-bg4 bg-everforest-bg0 overflow-hidden">
        <div className="sticky left-0 z-10 shrink-0 border-r border-everforest-bg4 bg-everforest-bg0" style={{ width: 96 }}>
          {layout.rows.map((row) => (
            <div key={row} className="px-2 text-[10px] text-everforest-grey2" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>{row}</div>
          ))}
        </div>
        <div ref={scrollRef} className="overflow-x-auto custom-scrollbar" style={{ maxHeight: 620 }}>
          <svg width={layout.width} height={layout.height} className="block">
            {layout.rows.map((row, i) => (
              <rect key={row} x={0} y={i * ROW_H} width={layout.width} height={ROW_H} fill={i % 2 ? '#343f44' : '#2d353b'} />
            ))}
            {visibleEdges.map((edge, i) => {
              const from = position.get(edge.from)
              const to = position.get(edge.to)
              if (!from || !to) return null
              const lit = highlight ? highlight.has(edge.from) && highlight.has(edge.to) : false
              return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={lit ? '#a7c080' : '#4f585e'} strokeWidth={lit ? 1.2 : 0.5} strokeOpacity={highlight && !lit ? 0.15 : 0.6} />
            })}
            {layout.nodes.map((node) => {
              const radius = 4 + Math.min(10, node.degree)
              const dimmed = highlight ? !highlight.has(node.id) : false
              return (
                <g key={node.id} transform={`translate(${node.x},${node.y})`} className="cursor-pointer" opacity={dimmed ? 0.3 : 1} onClick={() => setSelected((c) => (c === node.id ? null : node.id))} onMouseEnter={() => setHovered(node.id)} onMouseLeave={() => setHovered((c) => (c === node.id ? null : c))}>
                  <circle r={radius} fill={KIND_COLORS[node.kind] ?? KIND_COLORS.unknown} fillOpacity={0.85} stroke={selected === node.id ? '#d3c6aa' : '#232a2e'} strokeWidth={selected === node.id ? 2 : 0.5} />
                  {(node.kind === 'session' || selected === node.id || hovered === node.id) && (
                    <text x={radius + 3} y={3} fontSize={11} fill="#d3c6aa" stroke="#232a2e" strokeWidth={3} paintOrder="stroke" pointerEvents="none">
                      {node.label.length > 40 ? `${node.label.slice(0, 40)}…` : node.label}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
      </div>

      {selectedNode && (
        <div className="rounded-lg border border-everforest-aqua/30 bg-everforest-bg1/60 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: KIND_COLORS[selectedNode.kind] ?? KIND_COLORS.unknown }} />
            <span className="text-sm text-everforest-fg">{selectedNode.kind}</span>
            <code className="text-xs text-everforest-aqua">{selectedNode.label}</code>
            <span className="text-[11px] text-everforest-grey1">degree {selectedNode.degree}</span>
            {selectedNode.ts && <span className="text-[11px] text-everforest-grey1">{new Date(selectedNode.ts).toLocaleTimeString()}</span>}
            <span className="flex-1" />
            {openTarget && onOpenNode && (
              <button type="button" onClick={() => onOpenNode(selectedNode.id)} className="px-2 py-1 rounded bg-everforest-bg-blue text-everforest-blue border border-everforest-blue/30 text-xs hover:bg-everforest-bg-blue/70">
                Open in transcript
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {(neighborsOf.get(selectedNode.id) ?? []).slice(0, 40).map((neighbor) => (
              <button key={neighbor.id} type="button" onClick={() => setSelected(neighbor.id)} className="px-1.5 py-0.5 rounded bg-everforest-bg2 text-everforest-grey2 text-[10px] hover:bg-everforest-bg3">
                <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: KIND_COLORS[neighbor.kind] ?? KIND_COLORS.unknown }} />
                {neighbor.kind}: {neighbor.label.length > 24 ? `${neighbor.label.slice(0, 24)}…` : neighbor.label}
              </button>
            ))}
          </div>
        </div>
      )}

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
