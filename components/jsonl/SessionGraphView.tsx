'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Minus, Plus, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { computeLayout, nodeViewTarget, type LayoutNode } from '@/lib/jsonl/graph-layout'
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

const MIN_ZOOM = 0.2
const MAX_ZOOM = 8

export function SessionGraphView({ sessionId, onOpenNode }: { sessionId: string; onOpenNode?: (nodeId: string) => void }) {
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })

  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const dragMoved = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setHidden(new Set())
    setSelected(null)
    setView({ x: 0, y: 0, k: 1 })
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
    return computeLayout(nodes, edges, { width: 1400, height: 900, seed: 7 })
  }, [data, hidden])

  const position = useMemo(() => new Map((layout?.nodes ?? []).map((node) => [node.id, node])), [layout])
  // Only the busiest few nodes carry a permanent label; the rest label on hover/select.
  const labeledIds = useMemo(
    () => new Set([...(layout?.nodes ?? [])].sort((a, b) => b.degree - a.degree).slice(0, 20).map((node) => node.id)),
    [layout],
  )
  const visibleEdges = useMemo(
    () => (data ? data.edges.filter((edge) => position.has(edge.from) && position.has(edge.to)) : []),
    [data, position],
  )

  const nodeById = useMemo(() => new Map((layout?.nodes ?? []).map((node) => [node.id, node])), [layout])
  const neighborsOf = useCallback(
    (id: string): LayoutNode[] => {
      const ids = new Set<string>()
      for (const edge of visibleEdges) {
        if (edge.from === id) ids.add(edge.to)
        else if (edge.to === id) ids.add(edge.from)
      }
      return [...ids].map((nid) => nodeById.get(nid)).filter((node): node is LayoutNode => Boolean(node))
    },
    [visibleEdges, nodeById],
  )

  const highlightNodes = useMemo(() => {
    const focus = selected ?? hovered
    if (!focus) return null
    const set = new Set<string>([focus, ...neighborsOf(focus).map((node) => node.id)])
    return set
  }, [selected, hovered, neighborsOf])

  // Wheel zoom around the cursor (native listener so preventDefault works).
  useEffect(() => {
    const el = svgRef.current
    if (!el || !layout) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = ((event.clientX - rect.left) / rect.width) * layout.width
      const py = ((event.clientY - rect.top) / rect.height) * layout.height
      setView((current) => {
        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
        const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.k * factor))
        const wx = (px - current.x) / current.k
        const wy = (py - current.y) / current.k
        return { k, x: px - wx * k, y: py - wy * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [layout])

  const zoomBy = (factor: number): void => {
    if (!layout) return
    const cx = layout.width / 2
    const cy = layout.height / 2
    setView((current) => {
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.k * factor))
      const wx = (cx - current.x) / current.k
      const wy = (cy - current.y) / current.k
      return { k, x: cx - wx * k, y: cy - wy * k }
    })
  }

  const onMouseDown = (event: React.MouseEvent<SVGSVGElement>): void => {
    dragMoved.current = false
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }
  }
  const onMouseMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (!drag.current || !svgRef.current || !layout) return
    const rect = svgRef.current.getBoundingClientRect()
    const dx = ((event.clientX - drag.current.x) / rect.width) * layout.width
    const dy = ((event.clientY - drag.current.y) / rect.height) * layout.height
    if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved.current = true
    const base = drag.current
    setView((current) => ({ ...current, x: base.vx + dx, y: base.vy + dy }))
  }
  const endDrag = (): void => {
    drag.current = null
  }
  const selectNode = (id: string): void => {
    if (dragMoved.current) return
    setSelected((current) => (current === id ? null : id))
  }

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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-everforest-grey1">{data.nodes.length} nodes · {data.edges.length} edges{data.truncated ? ' (capped)' : ''} · drag to pan · scroll to zoom</span>
        <span className="flex-1" />
        <button type="button" onClick={() => zoomBy(1.25)} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Zoom in"><Plus className="w-3.5 h-3.5" /></button>
        <button type="button" onClick={() => zoomBy(1 / 1.25)} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Zoom out"><Minus className="w-3.5 h-3.5" /></button>
        <button type="button" onClick={() => setView({ x: 0, y: 0, k: 1 })} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Reset view"><RotateCcw className="w-3.5 h-3.5" /></button>
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

      <div className="rounded-lg border border-everforest-bg4 bg-everforest-bg0 overflow-hidden">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="w-full h-[620px] cursor-grab active:cursor-grabbing touch-none select-none"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
        >
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {visibleEdges.map((edge, i) => {
              const from = position.get(edge.from)
              const to = position.get(edge.to)
              if (!from || !to) return null
              const lit = highlightNodes ? highlightNodes.has(edge.from) && highlightNodes.has(edge.to) : false
              return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={lit ? '#a7c080' : '#4f585e'} strokeWidth={lit ? 1.2 : 0.6} strokeOpacity={highlightNodes && !lit ? 0.25 : 1} />
            })}
            {layout.nodes.map((node) => {
              const radius = 4 + Math.min(12, node.degree)
              const dimmed = highlightNodes ? !highlightNodes.has(node.id) : false
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  className="cursor-pointer"
                  onClick={() => selectNode(node.id)}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered((current) => (current === node.id ? null : current))}
                  opacity={dimmed ? 0.3 : 1}
                >
                  <circle r={radius} fill={KIND_COLORS[node.kind] ?? KIND_COLORS.unknown} fillOpacity={0.85} stroke={selected === node.id ? '#d3c6aa' : '#2d353b'} strokeWidth={selected === node.id ? 2 : 0.5} />
                  {(labeledIds.has(node.id) || selected === node.id || hovered === node.id) && (
                    <text
                      x={(radius + 3) / view.k}
                      y={3 / view.k}
                      fontSize={11 / view.k}
                      fill="#d3c6aa"
                      stroke="#232a2e"
                      strokeWidth={3 / view.k}
                      paintOrder="stroke"
                      pointerEvents="none"
                    >
                      {node.label.length > 40 ? `${node.label.slice(0, 40)}…` : node.label}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      {selectedNode && (
        <div className="rounded-lg border border-everforest-aqua/30 bg-everforest-bg1/60 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: KIND_COLORS[selectedNode.kind] ?? KIND_COLORS.unknown }} />
            <span className="text-sm text-everforest-fg">{selectedNode.kind}</span>
            <code className="text-xs text-everforest-aqua">{selectedNode.label}</code>
            <span className="text-[11px] text-everforest-grey1">degree {selectedNode.degree}</span>
            <span className="flex-1" />
            {openTarget && onOpenNode && (
              <button type="button" onClick={() => onOpenNode(selectedNode.id)} className="px-2 py-1 rounded bg-everforest-bg-blue text-everforest-blue border border-everforest-blue/30 text-xs hover:bg-everforest-bg-blue/70">
                Open in transcript
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {neighborsOf(selectedNode.id).slice(0, 40).map((neighbor) => (
              <button
                key={neighbor.id}
                type="button"
                onClick={() => setSelected(neighbor.id)}
                className="px-1.5 py-0.5 rounded bg-everforest-bg2 text-everforest-grey2 text-[10px] hover:bg-everforest-bg3"
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: KIND_COLORS[neighbor.kind] ?? KIND_COLORS.unknown }} />
                {neighbor.kind}: {neighbor.label.length > 24 ? `${neighbor.label.slice(0, 24)}…` : neighbor.label}
              </button>
            ))}
            {neighborsOf(selectedNode.id).length === 0 && <span className="text-[11px] text-everforest-grey1">No connections in view.</span>}
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
