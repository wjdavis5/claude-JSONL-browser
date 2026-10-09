/**
 * Deterministic, dependency-free force-directed layout for the session graph.
 * Pure and seeded so the same graph always renders the same way.
 */

import { parseGraphNodeId } from './session-db.ts'

export interface LayoutInputNode {
  id: string
  kind: string
  label: string
  degree: number
}

export interface LayoutInputEdge {
  from: string
  to: string
  type: string
}

export interface LayoutNode extends LayoutInputNode {
  x: number
  y: number
}

export interface Layout {
  nodes: LayoutNode[]
  width: number
  height: number
}

export interface LayoutOptions {
  width?: number
  height?: number
  iterations?: number
  seed?: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function computeLayout(nodes: LayoutInputNode[], edges: LayoutInputEdge[], options: LayoutOptions = {}): Layout {
  const width = options.width ?? 900
  const height = options.height ?? 620
  const iterations = options.iterations ?? 200
  const seed = options.seed ?? 1
  if (nodes.length === 0) return { nodes: [], width, height }

  const random = mulberry32(seed)
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const positions = nodes.map(() => ({ x: random() * width, y: random() * height }))
  const links = edges
    .map((edge) => [index.get(edge.from), index.get(edge.to)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined)
  const ideal = Math.sqrt((width * height) / nodes.length) * 0.85

  const disp = positions.map(() => ({ x: 0, y: 0 }))
  for (let step = 0; step < iterations; step += 1) {
    for (const d of disp) {
      d.x = 0
      d.y = 0
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        let dx = positions[i].x - positions[j].x
        let dy = positions[i].y - positions[j].y
        const dist = Math.hypot(dx, dy) || 0.01
        const force = (ideal * ideal) / dist
        dx /= dist
        dy /= dist
        disp[i].x += dx * force
        disp[i].y += dy * force
        disp[j].x -= dx * force
        disp[j].y -= dy * force
      }
    }
    for (const [a, b] of links) {
      let dx = positions[a].x - positions[b].x
      let dy = positions[a].y - positions[b].y
      const dist = Math.hypot(dx, dy) || 0.01
      const force = (dist * dist) / ideal
      dx /= dist
      dy /= dist
      disp[a].x -= dx * force
      disp[a].y -= dy * force
      disp[b].x += dx * force
      disp[b].y += dy * force
    }
    const temperature = Math.max(1, (1 - step / iterations) * (width / 10))
    for (let i = 0; i < nodes.length; i += 1) {
      const dist = Math.hypot(disp[i].x, disp[i].y) || 0.01
      const limited = Math.min(dist, temperature)
      positions[i].x = clamp(positions[i].x + (disp[i].x / dist) * limited, 0, width)
      positions[i].y = clamp(positions[i].y + (disp[i].y / dist) * limited, 0, height)
    }
  }

  return {
    nodes: nodes.map((node, i) => ({ ...node, x: positions[i].x, y: positions[i].y })),
    width,
    height,
  }
}

/** Maps a graph node id (`tool:<session>:<parent>` / `agent:<session>:<parent>`) to its viewer jump target. */
export function nodeViewTarget(nodeId: string): string | null {
  const parts = parseGraphNodeId(nodeId)
  return parts && (parts.kind === 'tool' || parts.kind === 'agent') ? parts.key : null
}

// ---------------------------------------------------------------------------
// Temporal layout (x = time)
// ---------------------------------------------------------------------------

const PACK_X = 20
const PACK_Y = 16

export interface TimeLayoutNode extends LayoutInputNode {
  x: number
  y: number
  ts?: number
}

export interface TimeLayout {
  nodes: TimeLayoutNode[]
  width: number
  height: number
  t0: number
  t1: number
}

/**
 * Places nodes on a time axis (x = (ts - t0) * pxPerMs) and packs them
 * vertically around the centre line so nodes close in time stack instead of
 * overlapping. No fixed lanes — the swarm shape itself shows density over time.
 */
export function computeTimeLayout(
  nodes: Array<LayoutInputNode & { ts?: number }>,
  options: { t0: number; t1: number; pxPerMs: number },
): TimeLayout {
  const ordered = [...nodes].sort((a, b) => (a.ts ?? options.t0) - (b.ts ?? options.t0))
  const placed: Array<{ node: LayoutInputNode & { ts?: number }; x: number; y: number }> = []
  for (const node of ordered) {
    const x = node.ts !== undefined ? (node.ts - options.t0) * options.pxPerMs : 0
    let y = 0
    let k = 0
    for (;;) {
      const candidate = k === 0 ? 0 : Math.ceil(k / 2) * PACK_Y * (k % 2 ? 1 : -1)
      const collides = placed.some((p) => Math.abs(p.x - x) < PACK_X && Math.abs(p.y - candidate) < PACK_Y)
      if (!collides) {
        y = candidate
        break
      }
      k += 1
      if (k > 4000) break
    }
    placed.push({ node, x, y })
  }
  const ys = placed.map((p) => p.y)
  const minY = Math.min(...ys, 0)
  const maxY = Math.max(...ys, 0)
  const pad = 36
  const height = maxY - minY + pad * 2
  const out = placed.map((p) => ({ ...p.node, x: p.x + 40, y: p.y - minY + pad }))
  const width = Math.max(240, (options.t1 - options.t0) * options.pxPerMs + 80)
  return { nodes: out, width, height, t0: options.t0, t1: options.t1 }
}

