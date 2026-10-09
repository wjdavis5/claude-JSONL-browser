'use client'

import React, { useMemo, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { SessionManifest } from '@/lib/jsonl/session-index'

const ROW = 20
const HEADER = 26
const LABEL_W = 240
const BASE_W = 1200
const MAX_ZOOM = 40

const STATUS_COLOR: Record<string, string> = { completed: '#83c092', running: '#dbbc7f', failed: '#e67e80' }

const STEPS = [1000, 5000, 10000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000, 7200000, 21600000, 43200000, 86400000]

function niceStep(ms: number): number {
  for (const step of STEPS) if (step >= ms) return step
  return STEPS[STEPS.length - 1]
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * Swimlane timeline. A fixed label column (never overlaps the bars) plus a
 * horizontally scrollable, zoomable time axis: the main thread's turns as ticks
 * and each subagent as a bar from its start to its end, so concurrency and
 * duration are visible.
 */
export function SessionTimeline({
  manifest,
  onOpenTurn,
  onOpenAgent,
}: {
  manifest: SessionManifest
  onOpenTurn: (i: number) => void
  onOpenAgent: (id: string) => void
}) {
  const [zoom, setZoom] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { t0, t1 } = useMemo(() => {
    const times: number[] = []
    for (const turn of manifest.turns) if (turn.ts) times.push(Date.parse(turn.ts))
    for (const agent of manifest.agents) {
      if (agent.tsStart) times.push(Date.parse(agent.tsStart))
      if (agent.tsEnd) times.push(Date.parse(agent.tsEnd))
    }
    const min = Math.min(...times)
    const max = Math.max(...times)
    return { t0: Number.isFinite(min) ? min : 0, t1: Number.isFinite(max) ? max : 1 }
  }, [manifest])

  const span = Math.max(1, t1 - t0)
  const svgWidth = BASE_W * zoom
  const xOf = (ms: number): number => ((ms - t0) / span) * svgWidth

  const agents = useMemo(
    () => [...manifest.agents].filter((agent) => agent.tsStart).sort((a, b) => (a.tsStart || '').localeCompare(b.tsStart || '')),
    [manifest],
  )
  const height = HEADER + (1 + agents.length) * ROW
  const minutes = Math.round(span / 60000)

  const { step, ticks } = useMemo(() => {
    const stepMs = niceStep((span / svgWidth) * 140)
    const out: number[] = []
    for (let t = Math.ceil(t0 / stepMs) * stepMs; t <= t1; t += stepMs) out.push(t)
    return { step: stepMs, ticks: out }
  }, [span, svgWidth, t0, t1])

  const zoomTo = (factor: number): void => {
    const el = scrollRef.current
    setZoom((current) => {
      const next = Math.max(1, Math.min(MAX_ZOOM, current * factor))
      if (el) {
        const centerFraction = (el.scrollLeft + el.clientWidth / 2) / (BASE_W * current)
        requestAnimationFrame(() => {
          el.scrollLeft = centerFraction * (BASE_W * next) - el.clientWidth / 2
        })
      }
      return next
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-everforest-grey1">
          {manifest.counts.userPrompts} prompts · {agents.length} subagents over ~{minutes} min · scroll to move, zoom to spread the time axis · click to open
        </span>
        <span className="flex-1" />
        <span className="text-everforest-grey1">tick {step >= 60000 ? `${Math.round(step / 60000)}m` : `${Math.round(step / 1000)}s`}</span>
        <button type="button" onClick={() => zoomTo(1.5)} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Zoom in"><Plus className="w-3.5 h-3.5" /></button>
        <button type="button" onClick={() => zoomTo(1 / 1.5)} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Zoom out"><Minus className="w-3.5 h-3.5" /></button>
      </div>

      <div ref={scrollRef} className="rounded-lg border border-everforest-bg4 bg-everforest-bg0 overflow-auto custom-scrollbar" style={{ maxHeight: 620 }}>
        <div className="flex" style={{ height }}>
          {/* Fixed label column — truncates, never overlaps the bars. */}
          <div className="sticky left-0 z-10 shrink-0 border-r border-everforest-bg4 bg-everforest-bg0" style={{ width: LABEL_W }}>
            <div style={{ height: HEADER }} className="border-b border-everforest-bg4" />
            <div className="px-2 text-[10px] text-everforest-fg bg-everforest-bg2" style={{ height: ROW, lineHeight: `${ROW}px` }}>
              main thread · {manifest.turns.length} turns
            </div>
            {agents.map((agent, i) => (
              <div
                key={agent.id}
                className="px-2 text-[10px] text-everforest-grey2 truncate"
                style={{ height: ROW, lineHeight: `${ROW}px`, background: i % 2 ? '#343f44' : '#2d353b' }}
                title={agent.description || agent.subagentType || agent.id}
              >
                {agent.description || agent.subagentType || agent.id}
              </div>
            ))}
          </div>

          {/* Time area */}
          <svg width={svgWidth} height={height} className="shrink-0">
            {/* time axis */}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={xOf(t)} y1={HEADER - 6} x2={xOf(t)} y2={height} stroke="#4f585e" strokeWidth={0.5} strokeOpacity={0.5} />
                <text x={xOf(t) + 2} y={HEADER - 8} fontSize={10} fill="#9da9a0">{formatClock(t)}</text>
              </g>
            ))}

            {/* main lane */}
            <rect x={0} y={HEADER} width={svgWidth} height={ROW} fill="#2d353b" />
            {manifest.turns.map((turn) =>
              turn.ts ? (
                <g key={turn.i} onClick={() => onOpenTurn(turn.i)} className="cursor-pointer">
                  <title>{`Turn ${turn.i} · ${turn.preview}`}</title>
                  <rect x={xOf(Date.parse(turn.ts)) - 1.5} y={HEADER + 4} width={3} height={ROW - 8} fill={turn.kind === 'prompt' ? '#a7c080' : '#dbbc7f'} />
                </g>
              ) : null,
            )}

            {/* agent lanes */}
            {agents.map((agent, i) => {
              const y = HEADER + (i + 1) * ROW
              const xs = xOf(Date.parse(agent.tsStart as string))
              const xe = agent.tsEnd ? xOf(Date.parse(agent.tsEnd)) : xs + 3
              const color = STATUS_COLOR[agent.status || ''] ?? '#7fbbb3'
              const label = agent.description || agent.subagentType || agent.id
              return (
                <g key={agent.id} onClick={() => onOpenAgent(agent.id)} className="cursor-pointer">
                  <title>{`${label}${agent.status ? ` · ${agent.status}` : ''}`}</title>
                  <rect x={0} y={y} width={svgWidth} height={ROW} fill={i % 2 ? '#343f44' : '#2d353b'} />
                  <rect x={xs} y={y + 4} width={Math.max(3, xe - xs)} height={ROW - 8} rx={2} fill={color} fillOpacity={0.85} />
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}
