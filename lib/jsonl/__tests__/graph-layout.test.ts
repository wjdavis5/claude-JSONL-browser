import { describe, expect, it } from 'vitest'
import { computeLayout, nodeViewTarget, type LayoutInputEdge, type LayoutInputNode } from '../graph-layout'

const makeNodes = (count: number): LayoutInputNode[] =>
  Array.from({ length: count }, (_, i) => ({ id: `tool:s:${i}`, kind: 'tool', label: `n${i}`, degree: 1 }))
const makeEdges = (count: number): LayoutInputEdge[] =>
  Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({ from: `tool:s:${i}`, to: `tool:s:${i + 1}`, type: 'x' }))

describe('graph layout', () => {
  it('is deterministic for a fixed seed', () => {
    const a = computeLayout(makeNodes(6), makeEdges(6), { seed: 3 })
    const b = computeLayout(makeNodes(6), makeEdges(6), { seed: 3 })
    expect(a.nodes.map((node) => [node.x, node.y])).toEqual(b.nodes.map((node) => [node.x, node.y]))
  })

  it('keeps every node within the viewport bounds', () => {
    const layout = computeLayout(makeNodes(20), makeEdges(20), { width: 400, height: 300, seed: 1 })
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.x).toBeLessThanOrEqual(400)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeLessThanOrEqual(300)
    }
  })

  it('returns an empty layout for no nodes', () => {
    expect(computeLayout([], [], {}).nodes).toEqual([])
  })

  it('maps item node ids to viewer jump targets', () => {
    expect(nodeViewTarget('tool:s:t0:1')).toBe('t0:1')
    expect(nodeViewTarget('agent:s:a:abc')).toBe('a:abc')
    expect(nodeViewTarget('file:/x')).toBeNull()
  })
})
