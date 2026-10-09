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
  const ideal = Math.sqrt((width * height) / nodes.length) * 0.5

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
