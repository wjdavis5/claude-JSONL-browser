import { describe, expect, it } from 'vitest'
import {
  dedupeGraph,
  extractFileOps,
  extractItemGraph,
  extractPullRequests,
  extractSessionGraph,
  graphNodeId,
  type GraphItem,
} from '../session-db'

const tool = (over: Partial<GraphItem> & { name: string }): GraphItem => ({ k: 'tool', ...over })

describe('graph extraction', () => {
  it('emits read and edit edges to one shared file node for a Read then Edit', () => {
    const read = extractItemGraph(tool({ name: 'Read', input: { file_path: '/repo/lib/a.ts' } }), { sessionId: 's1', parentId: 't0:1' })
    const edit = extractItemGraph(tool({ name: 'Edit', input: { file_path: '/repo/lib/a.ts' } }), { sessionId: 's1', parentId: 't0:2' })
    const file = graphNodeId('file', '/repo/lib/a.ts')
    expect(read.edges.some((e) => e.to === file && e.type === 'read')).toBe(true)
    expect(edit.edges.some((e) => e.to === file && e.type === 'edit')).toBe(true)
  })

  it('flags an orphaned tool result and produces no file edges', () => {
    const orphan = extractItemGraph(tool({ name: 'tool_result', result: 'stale output' }), { sessionId: 's1', parentId: 't9:0' })
    expect(orphan.nodes.some((n) => n.kind === 'tool_result' && n.props?.orphaned === true)).toBe(true)
    expect(orphan.edges.some((e) => e.type === 'read' || e.type === 'edit' || e.type === 'write')).toBe(false)
  })

  it('yields no file edge for a tool input with no recognizable path', () => {
    const ops = extractFileOps(tool({ name: 'Bash', input: { command: 'ls -la' } }))
    expect(ops).toHaveLength(0)
    const graph = extractItemGraph(tool({ name: 'Bash', input: { command: 'ls -la' } }), { sessionId: 's1', parentId: 't0:3' })
    expect(graph.nodes.some((n) => n.kind === 'file')).toBe(false)
  })

  it('connects two sessions through a shared file node', () => {
    const a = extractSessionGraph('sA', [{ item: tool({ name: 'Edit', input: { file_path: '/repo/lib/a.ts' } }), parentId: 't0:1' }])
    const b = extractSessionGraph('sB', [{ item: tool({ name: 'Read', input: { file_path: '/repo/lib/a.ts' } }), parentId: 't0:1' }])
    const merged = dedupeGraph([...a.nodes, ...b.nodes], [...a.edges, ...b.edges])
    const file = graphNodeId('file', '/repo/lib/a.ts')
    const sessionsTouching = merged.edges.filter((e) => e.to === file).map((e) => e.from)
    expect(new Set(sessionsTouching).size).toBeGreaterThanOrEqual(2)
    expect(merged.nodes.filter((n) => n.id === file)).toHaveLength(1)
  })

  it('links an agent spawn and parses PR references', () => {
    const agent = extractItemGraph(
      { k: 'agent', name: 'Agent', agentId: 'abc123', subagentType: 'explore', description: 'Explore repo' },
      { sessionId: 's1', parentId: 't0:4' },
    )
    expect(agent.edges.some((e) => e.type === 'spawns' && e.to === graphNodeId('agent', 'abc123'))).toBe(true)

    const prs = extractPullRequests(tool({ name: 'Bash', result: 'Created https://github.com/CVNA-Wholesale/platform-graph-mcp/pull/81' }))
    expect(prs).toEqual([{ repo: 'CVNA-Wholesale/platform-graph-mcp', number: '81' }])
  })
})
