import { describe, expect, it } from 'vitest'
import { buildAgentIndex, buildMainIndex, isRealPromptText, shardTurns, toolResultText } from '../session-index'

const line = (value: unknown) => value

function mainSession() {
  return [
    line({ type: 'mode', mode: 'normal', sessionId: 'session-x' }),
    line({
      type: 'user',
      timestamp: '2026-04-01T07:33:18.000Z',
      sessionId: 'session-x',
      gitBranch: 'main',
      cwd: '/project',
      message: { role: 'user', content: 'Please inspect this project' },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-04-01T07:33:19.000Z',
      sessionId: 'session-x',
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } },
        content: [
          { type: 'thinking', thinking: 'Let me look around.', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
    }),
    line({
      type: 'user',
      timestamp: '2026-04-01T07:33:20.000Z',
      sessionId: 'session-x',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file-a\nfile-b' }] },
      toolUseResult: { stdout: 'file-a\nfile-b', stderr: '', interrupted: false },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-04-01T07:33:21.000Z',
      sessionId: 'session-x',
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent',
            name: 'Agent',
            input: { subagent_type: 'explore', description: 'Explore repo', prompt: 'find things' },
          },
        ],
      },
    }),
    line({
      type: 'user',
      timestamp: '2026-04-01T07:33:22.000Z',
      sessionId: 'session-x',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'Async agent launched successfully.\nagentId: a1234567890abcdef' }],
      },
      toolUseResult: { agentId: 'a1234567890abcdef', status: 'running', isAsync: true, resolvedModel: 'claude-sonnet-5', description: 'Explore repo' },
    }),
    line({
      type: 'user',
      timestamp: '2026-04-01T07:34:00.000Z',
      sessionId: 'session-x',
      message: { role: 'user', content: 'Now do the next thing' },
    }),
    line({
      type: 'system',
      subtype: 'turn_duration',
      timestamp: '2026-04-01T07:34:01.000Z',
      durationMs: 1234,
      messageCount: 3,
    }),
  ]
}

describe('buildMainIndex', () => {
  const result = buildMainIndex(mainSession())

  it('starts a new turn for each real user prompt', () => {
    const prompts = result.turns.filter((turn) => turn.kind === 'prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[0].prompt).toBe('Please inspect this project')
    expect(prompts[1].prompt).toBe('Now do the next thing')
  })

  it('keeps thinking, tool call, and tool result together', () => {
    const turn = result.turns[0]
    const thinking = turn.items.find((item) => item.k === 'think')
    const tool = turn.items.find((item) => item.k === 'tool')
    expect(thinking?.text).toBe('Let me look around.')
    expect(tool?.name).toBe('Bash')
    expect(tool?.result).toBe('file-a\nfile-b')
    expect(tool?.isError).toBe(false)
  })

  it('links Agent tool calls to their subagent id', () => {
    const agentItem = result.turns[0].items.find((item) => item.k === 'agent')
    expect(agentItem?.agentId).toBe('a1234567890abcdef')
    expect(agentItem?.subagentType).toBe('explore')
    const link = result.agentLinks.get('a1234567890abcdef')
    expect(link?.parentId).toBeNull()
    expect(link?.model).toBe('claude-sonnet-5')
    expect(link?.isAsync).toBe(true)
  })

  it('produces turn headers with counts and tokens', () => {
    const header = result.manifest.turns[0]
    expect(header.toolCount).toBe(2)
    expect(header.agentCount).toBe(1)
    expect(header.thinkCount).toBe(1)
    expect(header.tokens?.out).toBe(20)
    expect(result.manifest.counts.userPrompts).toBe(2)
    expect(result.manifest.counts.agents).toBe(1)
  })

  it('produces search documents for prompts and tools', () => {
    const promptDocs = result.searchDocs.filter((doc) => doc.label === 'Prompt')
    expect(promptDocs.map((doc) => doc.text)).toContain('Please inspect this project')
    expect(result.searchDocs.some((doc) => doc.text.includes('ls -la'))).toBe(true)
  })

  it('captures session metadata', () => {
    expect(result.manifest.sessionId).toBe('session-x')
    expect(result.manifest.gitBranch).toBe('main')
    expect(result.manifest.models).toContain('claude-opus-5-5')
  })
})

describe('buildAgentIndex', () => {
  it('extracts the task, tools, and final text', () => {
    const records = [
      { type: 'user', timestamp: '2026-04-01T08:00:00.000Z', message: { role: 'user', content: 'You are a checker. Do the thing.' } },
      {
        type: 'assistant',
        timestamp: '2026-04-01T08:00:01.000Z',
        message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] },
      },
      { type: 'user', timestamp: '2026-04-01T08:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] } },
      { type: 'assistant', timestamp: '2026-04-01T08:00:03.000Z', message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'All done.' }] } },
    ]
    const built = buildAgentIndex('abc123', records, { agentId: 'abc123', parentId: null, subagentType: 'checker' })
    expect(built.header.task).toContain('You are a checker')
    expect(built.header.finalText).toBe('All done.')
    expect(built.header.tools.Read).toBe(1)
    expect(built.header.model).toBe('claude-haiku-4-5')
    expect(built.searchDoc.kind).toBe('agent')
  })

  it('records nested agent links with the parent id', () => {
    const records = [
      { type: 'user', message: { role: 'user', content: 'parent task' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Agent', input: { subagent_type: 'x', description: 'child', prompt: 'go' } }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'agentId: child999' }] },
        toolUseResult: { agentId: 'child999', isAsync: true },
      },
    ]
    const built = buildAgentIndex('parent1', records)
    expect(built.links.get('child999')?.parentId).toBe('parent1')
  })
})

describe('helpers', () => {
  it('classifies real prompts', () => {
    expect(isRealPromptText('hello world', false)).toBe(true)
    expect(isRealPromptText('<local-command-caveat>hi</local-command-caveat>', false)).toBe(false)
    expect(isRealPromptText('<command-name>/model</command-name>', false)).toBe(false)
    expect(isRealPromptText('meta', true)).toBe(false)
    expect(isRealPromptText('<system-reminder>x</system-reminder>\nreal question', false)).toBe(true)
  })

  it('flattens tool result content', () => {
    expect(toolResultText('plain')).toBe('plain')
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(toolResultText([{ type: 'image', source: {} }])).toBe('[image]')
  })

  it('shards turns by size', () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({ i, kind: 'prompt' as const, items: [] }))
    const shards = shardTurns(turns, 2)
    expect(shards).toHaveLength(3)
    expect(shards[0].turns.map((t) => t.i)).toEqual([0, 1])
    expect(shards[2].turns.map((t) => t.i)).toEqual([4])
  })
})
