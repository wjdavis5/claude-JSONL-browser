'use client'

import React, { useMemo, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { SessionManifest } from '@/lib/jsonl/session-index'

const ROW = 18
const LABEL_W = 220
const BASE_W = 1200

const STATUS_COLOR: Record<string, string> = { completed: '#83c092', running: '#dbbc7f', failed: '#e67e80' }

/**
 * Swimlane timeline: the main thread's turns as ticks on one lane, and each
 * subagent as a bar spanning its start→end — so concurrency and duration are
 * visible. Built from the manifest (no database required).
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
  const width = BASE_W * zoom
  const xOf = (ms: number): number => LABEL_W + ((ms - t0) / span) * (width - LABEL_W)

  const agents = useMemo(
    () => [...manifest.agents].filter((agent) => agent.tsStart).sort((a, b) => (a.tsStart || '').localeCompare(b.tsStart || '')),
    [manifest],
  )
  const height = (1 + agents.length) * ROW
  const minutes = Math.round(span / 60000)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-everforest-grey1">
          {manifest.counts.userPrompts} prompts · {agents.length} subagents over ~{minutes} min · click a mark to open
        </span>
        <span className="flex-1" />
        <button type="button" onClick={() => setZoom((z) => Math.min(16, z * 1.5))} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Zoom in"><Plus className="w-3.5 h-3.5" /></button>
        <button type="button" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} className="p-1 rounded border border-everforest-bg4 hover:bg-everforest-bg2" aria-label="Zoom out"><Minus className="w-3.5 h-3.5" /></button>
      </div>

      <div className="rounded-lg border border-everforest-bg4 bg-everforest-bg0 overflow-auto custom-scrollbar" style={{ maxHeight: 620 }}>
        <svg width={width} height={height} className="block">
          {/* main lane */}
          <rect x={0} y={0} width={width} height={ROW} fill="#2d353b" />
          {manifest.turns.map((turn) =>
            turn.ts ? (
              <g key={turn.i} onClick={() => onOpenTurn(turn.i)} className="cursor-pointer">
                <title>{`Turn ${turn.i} · ${turn.preview}`}</title>
                <rect x={xOf(Date.parse(turn.ts)) - 1.5} y={3} width={3} height={ROW - 6} fill={turn.kind === 'prompt' ? '#a7c080' : '#dbbc7f'} />
              </g>
            ) : null,
          )}
          <text x={6} y={ROW - 5} fontSize={10} fill="#9da9a0">main thread · {manifest.turns.length} turns</text>

          {/* agent lanes */}
          {agents.map((agent, i) => {
            const y = (i + 1) * ROW
            const start = Date.parse(agent.tsStart as string)
            const xs = xOf(start)
            const xe = agent.tsEnd ? xOf(Date.parse(agent.tsEnd)) : xs + 3
            const color = STATUS_COLOR[agent.status || ''] ?? '#7fbbb3'
            const label = (agent.description || agent.subagentType || agent.id).slice(0, 40)
            return (
              <g key={agent.id} onClick={() => onOpenAgent(agent.id)} className="cursor-pointer">
                <title>{`${label}${agent.status ? ` · ${agent.status}` : ''}`}</title>
                <rect x={0} y={y} width={width} height={ROW} fill={i % 2 ? '#343f44' : '#2d353b'} />
                <rect x={xs} y={y + 3} width={Math.max(3, xe - xs)} height={ROW - 6} rx={2} fill={color} fillOpacity={0.85} />
                <text x={6} y={y + ROW - 5} fontSize={9} fill="#9da9a0">{label}</text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
