/**
 * Session index model + pure transforms.
 *
 * A Claude Code session can be enormous (the reference session is ~70 MB for the
 * main transcript plus ~900 MB of subagent transcripts). Loading that into the
 * browser is not viable, so we preprocess it into:
 *
 *   - a small `manifest.json` (session metadata, turn headers, agent headers)
 *   - per-shard turn bodies (`turns/<n>.json`) fetched on demand
 *   - per-agent bodies (`agents/<id>.json`) fetched on demand
 *   - a compact `search.json` of truncated, searchable documents
 *
 * This module has **no relative imports** so it can be executed directly by Node
 * (type stripping) from `scripts/build-session-index.ts` and imported by the app.
 */

export const SESSION_INDEX_VERSION = 1

export type SessionItemKind =
  | 'prompt'
  | 'text'
  | 'think'
  | 'tool'
  | 'agent'
  | 'attach'
  | 'sys'
  | 'note'
  | 'compact'

export interface SessionItem {
  /** Kind of block. */
  k: SessionItemKind
  /** ISO timestamp when known. */
  ts?: string
  /** Text payload for prompt/text/think/note/compact. */
  text?: string
  /** Tool name for tool/agent items. */
  name?: string
  /** Tool input (verbatim, may be large). */
  input?: unknown
  /** Flattened tool result text. */
  result?: string
  /** Whether the tool result reported an error. */
  isError?: boolean
  /** Linked subagent id for Agent/Task calls. */
  agentId?: string
  /** Agent subagent_type for Agent/Task calls. */
  subagentType?: string
  /** Agent description for Agent/Task calls. */
  description?: string
  /** Small curated structured metadata (never large blobs). */
  meta?: Record<string, unknown>
}

export interface Turn {
  /** Zero-based turn index. */
  i: number
  /** How the turn started. */
  kind: 'session' | 'prompt' | 'system'
  ts?: string
  endTs?: string
  /** Full user prompt for prompt turns (system turns may omit). */
  prompt?: string
  /** Ordered blocks. */
  items: SessionItem[]
}

export interface TurnHeader {
  i: number
  kind: Turn['kind']
  ts?: string
  endTs?: string
  /** Short prompt preview for the outline (truncated). */
  preview: string
  toolCount: number
  agentCount: number
  thinkCount: number
  models: string[]
  tokens?: { in: number; out: number; think: number; cacheRead: number; cacheCreate: number }
  bytes: number
}

export interface AgentHeader {
  id: string
  /** Parent agent id, or null when launched from the main thread. */
  parentId: string | null
  subagentType?: string
  description?: string
  model?: string
  status?: string
  isAsync?: boolean
  tsStart?: string
  tsEnd?: string
  /** First user message in the subagent transcript (truncated). */
  task: string
  /** Last assistant text block (truncated). */
  finalText: string
  tools: Record<string, number>
  itemCount: number
  bytes: number
}

export interface SearchDoc {
  id: string
  kind: 'turn' | 'agent'
  /** Turn index for turn docs. */
  turn?: number
  /** Item index within the turn for turn docs. */
  item?: number
  /** Agent id for agent docs. */
  agent?: string
  label: string
  text: string
}

export interface SessionCounts {
  turns: number
  items: number
  userPrompts: number
  toolCalls: number
  agents: number
  thinking: number
  attachments: number
  system: number
}

export interface SessionManifest {
  version: number
  id: string
  title?: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  cliVersion?: string
  builtAt: string
  sessionStart?: string
  sessionEnd?: string
  models: string[]
  lastPrompt?: string
  bridgeSessionId?: string
  prLinks: Array<{ number?: number; url?: string; repository?: string; ts?: string }>
  cost?: {
    totalCostUSD?: number
    totalDurationMs?: number
    totalApiDurationMs?: number
    totalToolDurationMs?: number
    linesAdded?: number
    linesRemoved?: number
    modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; thinkingTokens?: number; costUSD?: number }>
  }
  counts: SessionCounts
  turnShardSize: number
  turnShardCount: number
  turns: TurnHeader[]
  agents: AgentHeader[]
}

export interface TurnShard {
  shard: number
  turns: Turn[]
}

export interface AgentBody {
  id: string
  header: AgentHeader
  items: SessionItem[]
}

export interface SessionCatalogEntry {
  id: string
  title?: string
  builtAt: string
  counts: SessionCounts
  models: string[]
  sessionStart?: string
  sessionEnd?: string
  bytes: number
}

export interface SessionCatalog {
  version: number
  sessions: SessionCatalogEntry[]
}

export interface BuildMainOptions {
  /** Cap for attachment previews (bytes of text kept). */
  attachmentPreviewLimit?: number
  /** Cap for search doc text. */
  searchLimit?: number
  turnShardSize?: number
}

export interface BuildMainResult {
  manifest: SessionManifest
  turns: Turn[]
  searchDocs: SearchDoc[]
  /** agentId -> link metadata observed from Agent/Task tool calls. */
  agentLinks: Map<string, AgentLink>
  bytes: number
}

export interface AgentLink {
  agentId: string
  subagentType?: string
  description?: string
  model?: string
  status?: string
  isAsync?: boolean
  /** Set when the link was observed inside another subagent. */
  parentId: string | null
}

const MAIN_AGENT_TOOLS = new Set(['Agent', 'Task'])
const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const TAG_RE = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)

/** Metadata-only record types that never become timeline items. */
const IGNORED_RECORD_TYPES = new Set([
  'mode',
  'permission-mode',
  'atis-latch',
  'file-history-snapshot',
  'file-history-delta',
  'bridge-session',
  'queue-operation',
  'last-prompt',
  'pr-link',
  'ai-title',
  'cost-state',
])

export function isRealPromptText(text: string, isMeta: boolean): boolean {
  if (isMeta) return false
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('<local-command')) return false
  if (trimmed.startsWith('<command-name>')) return false
  if (trimmed.startsWith('<local-command-stdout>')) return false
  if (trimmed.startsWith('<task-notification>')) return false
  if (trimmed.startsWith('<system-reminder>') && SYSTEM_REMINDER_RE.test(trimmed)) {
    SYSTEM_REMINDER_RE.lastIndex = 0
    const rest = trimmed.replace(SYSTEM_REMINDER_RE, '').trim()
    return rest.length > 0
  }
  if (trimmed.startsWith('This session is being continued')) return false
  return true
}

export function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '').trim()
}

export function isCompactContinuation(text: string): boolean {
  return text.trim().startsWith('This session is being continued')
}

export function extractTaskNotification(text: string): string | null {
  const match = text.match(TASK_NOTIFICATION_RE)
  if (!match) return null
  const inner = match[1]
  const summary = inner.match(TAG_RE('summary'))?.[1]
  const status = inner.match(TAG_RE('status'))?.[1]
  const taskId = inner.match(TAG_RE('task-id'))?.[1]
  return [status ? `[${status.trim()}]` : '', summary?.trim() || taskId?.trim() || 'Task notification']
    .filter(Boolean)
    .join(' ')
}

function tagValue(input: string, tag: string): string {
  return input.match(TAG_RE(tag))?.[1]?.trim() || ''
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return !!value && typeof value === 'object' && (value as { type?: string }).type === 'text'
}

/** Flattens a tool_result `content` payload (string | block[]) into plain text. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (isTextBlock(block)) return block.text
        if (block && typeof block === 'object') {
          const type = (block as { type?: string }).type
          if (type === 'image') return '[image]'
          if (type === 'tool_reference') {
            const name = (block as { tool_name?: string }).tool_name || 'tool'
            return `[tool reference: ${name}]`
          }
          try {
            return JSON.stringify(block)
          } catch {
            return String(block)
          }
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content, null, 2)
    } catch {
      return String(content)
    }
  }
  return ''
}

function truncate(value: string | undefined, limit: number): string {
  if (!value) return ''
  if (value.length <= limit) return value
  return value.slice(0, limit)
}

function safeStringify(value: unknown, limit = 4000): string {
  if (value === undefined || value === null) return ''
  try {
    const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return truncate(json, limit)
  } catch {
    return String(value)
  }
}

function parseAgentIdFromText(text: string): string | undefined {
  return text.match(/agentId:\s*([a-z0-9]+)/i)?.[1]
}

/**
 * Curated, small structured metadata for a tool call. Deliberately avoids
 * duplicating large payloads (stdout/stderr/file contents) that are already in
 * the tool result text.
 */
export function pickToolMeta(name: string | undefined, toolUseResult: unknown): Record<string, unknown> | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined
  const tur = toolUseResult as Record<string, unknown>
  const meta: Record<string, unknown> = {}

  if (tur.filePath) meta.filePath = tur.filePath
  if (tur.numLines !== undefined) meta.numLines = tur.numLines
  if (tur.totalLines !== undefined) meta.totalLines = tur.totalLines
  if (tur.returnCodeInterpretation) meta.returnCodeInterpretation = tur.returnCodeInterpretation
  if (tur.interrupted) meta.interrupted = true
  if (tur.isImage) meta.isImage = true
  if (tur.noOutputExpected) meta.noOutputExpected = true
  if (tur.isAsync) meta.isAsync = true
  if (tur.status) meta.status = tur.status
  if (tur.resolvedModel) meta.resolvedModel = tur.resolvedModel
  if (tur.agentId) meta.agentId = tur.agentId
  if (tur.backgroundTaskId) meta.backgroundTaskId = tur.backgroundTaskId
  if (tur.taskId) meta.taskId = tur.taskId
  if (tur.id && typeof tur.id === 'string') meta.id = tur.id
  if (tur.humanSchedule) meta.humanSchedule = tur.humanSchedule
  if (tur.recurring !== undefined) meta.recurring = tur.recurring
  if (tur.durable !== undefined) meta.durable = tur.durable
  if (tur.total_deferred_tools !== undefined) meta.totalDeferredTools = tur.total_deferred_tools
  if (tur.message && typeof tur.message === 'string') meta.message = truncate(tur.message, 400)
  if (tur.success !== undefined) meta.success = tur.success
  if (Array.isArray(tur.answers)) meta.answers = tur.answers
  if (Array.isArray(tur.questions)) {
    meta.questions = tur.questions.map((q) => {
      const question = (q as { question?: string; header?: string }) || {}
      return { header: truncate(question.header, 120), question: truncate(question.question, 400) }
    })
  }
  if (Array.isArray(tur.structuredPatch) && tur.structuredPatch.length > 0) {
    meta.patchLines = tur.structuredPatch.length
  }

  return Object.keys(meta).length > 0 ? meta : undefined
}

interface BuildState {
  items: SessionItem[]
  toolIndex: Map<string, number>
}

function makeState(): BuildState {
  return { items: [], toolIndex: new Map() }
}

function pushItem(state: BuildState, item: SessionItem): number {
  state.items.push(item)
  return state.items.length - 1
}

function renderAssistantContent(state: BuildState, content: unknown, ts: string | undefined, links: Map<string, AgentLink>): void {
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    const type = block.type

    if (type === 'text') {
      const text = String(block.text ?? '')
      if (text) pushItem(state, { k: 'text', ts, text })
      continue
    }
    if (type === 'thinking') {
      const thinking = String(block.thinking ?? '')
      if (thinking) pushItem(state, { k: 'think', ts, text: thinking })
      continue
    }
    if (type === 'tool_use') {
      const name = String(block.name ?? 'tool')
      const id = block.id ? String(block.id) : undefined
      const isAgent = MAIN_AGENT_TOOLS.has(name)
      const input = block.input as Record<string, unknown> | undefined
      const index = pushItem(state, {
        k: isAgent ? 'agent' : 'tool',
        ts,
        name,
        input: block.input,
        subagentType: isAgent ? (input?.subagent_type as string | undefined) : undefined,
        description: isAgent ? (input?.description as string | undefined) : undefined,
      })
      if (id) state.toolIndex.set(id, index)
      continue
    }
    if (type === 'redacted_thinking') {
      pushItem(state, { k: 'think', ts, text: '[redacted thinking]' })
      continue
    }
    if (type === 'image') {
      pushItem(state, { k: 'attach', ts, meta: { attType: 'image' }, text: '[image]' })
      continue
    }
    if (type === 'tool_reference') {
      const name = String(block.tool_name ?? 'tool')
      pushItem(state, { k: 'note', ts, text: `Tool reference: ${name}` })
      continue
    }
  }
}

function applyToolResults(
  state: BuildState,
  content: unknown,
  ts: string | undefined,
  toolUseResult: unknown,
  links: Map<string, AgentLink>,
  parentId: string | null,
): void {
  const blocks = Array.isArray(content) ? content : []
  const matched: Array<{ toolUseId?: string; text: string; isError: boolean }> = []
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    if (block.type !== 'tool_result' && !block.tool_use_id) continue
    matched.push({
      toolUseId: block.tool_use_id ? String(block.tool_use_id) : undefined,
      text: toolResultText(block.content),
      isError: block.is_error === true,
    })
  }
  if (matched.length === 0) return

  matched.forEach((result, i) => {
    const index = result.toolUseId ? state.toolIndex.get(result.toolUseId) : undefined
    const tur = i === 0 ? toolUseResult : undefined
    if (index !== undefined) {
      const item = state.items[index]
      item.result = result.text
      item.isError = result.isError
      const meta = pickToolMeta(item.name, tur)
      if (meta) item.meta = { ...(item.meta || {}), ...meta }
      if (item.k === 'agent' || MAIN_AGENT_TOOLS.has(item.name || '')) {
        const turAgentId = tur && typeof tur === 'object' ? (tur as { agentId?: string }).agentId : undefined
        const agentId = turAgentId || (item.meta?.agentId as string | undefined) || parseAgentIdFromText(result.text)
        if (agentId) {
          item.agentId = agentId
          const link: AgentLink = {
            agentId,
            subagentType: item.subagentType,
            description: item.description,
            model: (item.meta?.resolvedModel as string | undefined) || undefined,
            status: (item.meta?.status as string | undefined) || undefined,
            isAsync: (item.meta?.isAsync as boolean | undefined) || undefined,
            parentId,
          }
          links.set(agentId, link)
        }
      }
      return
    }
    // Orphaned tool result (its tool_use was in a compacted-away region).
    pushItem(state, {
      k: 'tool',
      ts,
      name: 'tool_result',
      result: result.text,
      isError: result.isError,
      meta: pickToolMeta(undefined, tur),
    })
  })
}

function renderAttachment(state: BuildState, attachment: Record<string, unknown>, previewLimit: number, ts?: string): void {
  const attType = String(attachment.type || 'attachment')
  let text = ''
  const rendered = attachment.rendered
  if (Array.isArray(rendered)) {
    text = rendered
      .map((r) => (r && typeof r === 'object' ? String((r as { content?: string }).content ?? '') : ''))
      .filter(Boolean)
      .join('\n\n')
  }
  if (!text) {
    const clone: Record<string, unknown> = { ...attachment }
    delete clone.snapshot
    delete clone.rendered
    text = safeStringify(clone, previewLimit)
  }
  pushItem(state, {
    k: 'attach',
    ts,
    text: truncate(text, previewLimit),
    meta: { attType },
  })
}

function renderSystem(state: BuildState, record: Record<string, unknown>, ts?: string): void {
  const subtype = String(record.subtype || 'system')
  let text = ''
  if (subtype === 'turn_duration') {
    const seconds = typeof record.durationMs === 'number' ? (record.durationMs / 1000).toFixed(1) : undefined
    text = `Turn duration${seconds ? `: ${seconds}s` : ''}${record.messageCount ? ` · ${record.messageCount} messages` : ''}`
  } else if (subtype === 'stop_hook_summary') {
    text = `Stop hook ran ${record.hookCount ?? 0} hook${record.hookCount === 1 ? '' : 's'}`
  } else if (typeof record.content === 'string') {
    const command = tagValue(record.content, 'command-name')
    const stdout = tagValue(record.content, 'local-command-stdout')
    text = [command ? `Command: ${command}` : '', stdout].filter(Boolean).join('\n')
  } else {
    text = safeStringify(record, 2000)
  }
  pushItem(state, { k: 'sys', ts, text, meta: { subtype } })
}

function usageToTokens(usage: unknown): { in: number; out: number; think: number; cacheRead: number; cacheCreate: number } | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const details = (u.output_tokens_details as Record<string, unknown>) || {}
  return {
    in: Number(u.input_tokens || 0),
    out: Number(u.output_tokens || 0),
    think: Number(details.thinking_tokens || 0),
    cacheRead: Number(u.cache_read_input_tokens || 0),
    cacheCreate: Number(u.cache_creation_input_tokens || 0),
  }
}

function addTokens(
  a: TurnHeader['tokens'],
  b: TurnHeader['tokens'],
): TurnHeader['tokens'] {
  if (!b) return a
  if (!a) return { ...b }
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    think: a.think + b.think,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
  }
}

function headerFromTurn(turn: Turn): TurnHeader {
  const toolCount = turn.items.filter((item) => item.k === 'tool' || item.k === 'agent').length
  const agentCount = turn.items.filter((item) => item.k === 'agent').length
  const thinkCount = turn.items.filter((item) => item.k === 'think').length
  const bytes = turn.items.reduce((sum, item) => sum + itemBytes(item), 0)
  return {
    i: turn.i,
    kind: turn.kind,
    ts: turn.ts,
    endTs: turn.endTs,
    preview: truncate((turn.prompt || turn.items.find((item) => item.k === 'prompt' || item.k === 'text')?.text || '').replace(/\s+/g, ' '), 240),
    toolCount,
    agentCount,
    thinkCount,
    models: [],
    bytes,
  }
}

function itemBytes(item: SessionItem): number {
  let size = (item.text?.length || 0) + (item.result?.length || 0)
  if (item.input !== undefined) {
    try {
      size += JSON.stringify(item.input)?.length || 0
    } catch {
      /* ignore */
    }
  }
  return size
}

function turnToSearchDocs(turn: Turn, limit: number, out: SearchDoc[]): void {
  turn.items.forEach((item, index) => {
    let text = ''
    let label = ''
    switch (item.k) {
      case 'prompt':
        label = 'Prompt'
        text = truncate(item.text, limit)
        break
      case 'text':
        label = 'Assistant'
        text = truncate(item.text, limit)
        break
      case 'think':
        label = 'Thinking'
        text = truncate(item.text, Math.floor(limit / 2))
        break
      case 'compact':
        label = 'Compaction summary'
        text = truncate(item.text, limit)
        break
      case 'agent':
        label = `Agent · ${item.subagentType || item.name || 'subagent'}`
        text = truncate([item.description, safeStringify(item.input, limit)].filter(Boolean).join('\n'), limit)
        break
      case 'tool':
        label = `Tool · ${item.name || 'tool'}`
        text = truncate(
          [safeStringify(item.input, Math.floor(limit / 2)), truncate(item.result, Math.floor(limit / 2))]
            .filter(Boolean)
            .join('\n'),
          limit,
        )
        break
      case 'note':
        label = 'Note'
        text = truncate(item.text, 400)
        break
      case 'attach':
        label = `Attachment · ${String(item.meta?.attType || '')}`
        text = truncate(item.text, 400)
        break
      case 'sys':
        label = `System · ${String(item.meta?.subtype || '')}`
        text = truncate(item.text, 300)
        break
      default:
        return
    }
    if (!text) return
    out.push({ id: `t${turn.i}:${index}`, kind: 'turn', turn: turn.i, item: index, label, text })
  })
}

export function buildMainIndex(records: unknown[], options: BuildMainOptions = {}): BuildMainResult {
  const attachmentPreviewLimit = options.attachmentPreviewLimit ?? 600
  const searchLimit = options.searchLimit ?? 2000
  const turnShardSize = options.turnShardSize ?? 12

  const turns: Turn[] = []
  const searchDocs: SearchDoc[] = []
  const links = new Map<string, AgentLink>()
  const models = new Set<string>()
  const tokenByTurn = new Map<number, TurnHeader['tokens']>()

  let current: Turn | null = null
  let state: BuildState = makeState()
  let sessionStart: string | undefined
  let sessionEnd: string | undefined
  let title: string | undefined
  let lastPrompt: string | undefined
  let bridgeSessionId: string | undefined
  let cost: SessionManifest['cost']
  const prLinks: SessionManifest['prLinks'] = []
  let sessionMeta: { sessionId?: string; cwd?: string; gitBranch?: string; version?: string } = {}

  const flush = (endTs?: string) => {
    if (!current) return
    current.items = state.items
    current.endTs = endTs
    turns.push(current)
    current = null
    state = makeState()
  }

  const startTurn = (kind: Turn['kind'], ts?: string, prompt?: string) => {
    flush(ts)
    current = { i: turns.length, kind, ts, prompt, items: [] }
    state = makeState()
    if (prompt) state.items.push({ k: 'prompt', ts, text: prompt })
  }

  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const type = record.type
    const ts = typeof record.timestamp === 'string' ? record.timestamp : undefined
    if (ts) {
      if (!sessionStart) sessionStart = ts
      sessionEnd = ts
    }
    if (record.sessionId && !sessionMeta.sessionId) sessionMeta.sessionId = String(record.sessionId)
    if (record.cwd && !sessionMeta.cwd) sessionMeta.cwd = String(record.cwd)
    if (record.gitBranch && !sessionMeta.gitBranch) sessionMeta.gitBranch = String(record.gitBranch)
    if (record.version && !sessionMeta.version) sessionMeta.version = String(record.version)

    if (type === 'ai-title') {
      if (record.aiTitle) title = String(record.aiTitle)
      continue
    }
    if (type === 'last-prompt') {
      if (record.lastPrompt) lastPrompt = String(record.lastPrompt)
      continue
    }
    if (type === 'bridge-session') {
      if (record.bridgeSessionId) bridgeSessionId = String(record.bridgeSessionId)
      continue
    }
    if (type === 'pr-link') {
      prLinks.push({
        number: typeof record.prNumber === 'number' ? record.prNumber : undefined,
        url: record.prUrl ? String(record.prUrl) : undefined,
        repository: record.prRepository ? String(record.prRepository) : undefined,
        ts,
      })
      continue
    }
    if (type === 'cost-state') {
      const modelUsage = record.modelUsage as Record<string, Record<string, unknown>> | undefined
      cost = {
        totalCostUSD: Number(record.totalCostUSD || 0) || undefined,
        totalDurationMs: Number(record.totalDuration || 0) || undefined,
        totalApiDurationMs: Number(record.totalAPIDuration || 0) || undefined,
        totalToolDurationMs: Number(record.totalToolDuration || 0) || undefined,
        linesAdded: Number(record.totalLinesAdded || 0) || undefined,
        linesRemoved: Number(record.totalLinesRemoved || 0) || undefined,
        modelUsage: modelUsage
          ? Object.fromEntries(
              Object.entries(modelUsage).map(([model, usage]) => [
                model,
                {
                  inputTokens: Number(usage.inputTokens || 0),
                  outputTokens: Number(usage.outputTokens || 0),
                  thinkingTokens: Number(usage.thinkingTokens || 0),
                  costUSD: Number(usage.costUSD || 0),
                },
              ]),
            )
          : undefined,
      }
      continue
    }
    if (type === 'queue-operation') {
      const content = typeof record.content === 'string' ? record.content : ''
      const summary = extractTaskNotification(content)
      if (summary) {
        if (!current) startTurn('session', ts)
        pushItem(state, { k: 'note', ts, text: summary, meta: { subtype: 'task-notification' } })
      }
      continue
    }
    if (IGNORED_RECORD_TYPES.has(String(type))) continue

    if (type === 'user') {
      const message = record.message as { content?: unknown } | undefined
      const content = message?.content
      if (typeof content === 'string') {
        const isMeta = record.isMeta === true
        if (isCompactContinuation(content)) {
          startTurn('system', ts)
          pushItem(state, { k: 'compact', ts, text: content })
          continue
        }
        if (isRealPromptText(content, isMeta)) {
          startTurn('prompt', ts, stripSystemReminders(content))
          continue
        }
        if (!current) startTurn('session', ts)
        const notification = extractTaskNotification(content)
        if (notification) {
          pushItem(state, { k: 'note', ts, text: notification, meta: { subtype: 'task-notification' } })
        } else if (content.includes('<system-reminder>')) {
          renderAttachment(state, { type: 'system-reminder', rendered: [{ content: stripSystemReminders(content) }] }, attachmentPreviewLimit, ts)
        } else {
          pushItem(state, { k: 'note', ts, text: truncate(content, 1000), meta: { meta: isMeta } })
        }
        continue
      }
      if (Array.isArray(content)) {
        if (!current) startTurn('session', ts)
        const hasToolResult = content.some((block) => block && typeof block === 'object' && ((block as Record<string, unknown>).type === 'tool_result' || (block as Record<string, unknown>).tool_use_id))
        if (hasToolResult) {
          applyToolResults(state, content, ts, record.toolUseResult, links, null)
        } else {
          const text = content
            .filter(isTextBlock)
            .map((block) => block.text)
            .join('\n')
          if (text) {
            if (isRealPromptText(text, record.isMeta === true)) {
              startTurn('prompt', ts, stripSystemReminders(text))
            } else {
              pushItem(state, { k: 'note', ts, text: truncate(text, 1000) })
            }
          }
        }
        continue
      }
      continue
    }

    if (type === 'assistant') {
      if (!current) startTurn('session', ts)
      const message = record.message as { content?: unknown; model?: string; usage?: unknown } | undefined
      const model = message?.model
      if (model) {
        models.add(model)
        const header = turns.length
        tokenByTurn.set(header, addTokens(tokenByTurn.get(header), usageToTokens(message?.usage)))
      } else {
        tokenByTurn.set(turns.length, addTokens(tokenByTurn.get(turns.length), usageToTokens(message?.usage)))
      }
      renderAssistantContent(state, message?.content, ts, links)
      continue
    }

    if (type === 'attachment') {
      if (!current) startTurn('session', ts)
      const attachment = (record.attachment as Record<string, unknown>) || {}
      renderAttachment(state, attachment, attachmentPreviewLimit, ts)
      continue
    }

    if (type === 'system') {
      if (record.subtype === 'compact_boundary') {
        startTurn('system', ts)
      }
      if (!current) startTurn('session', ts)
      renderSystem(state, record, ts)
      continue
    }
  }

  flush(sessionEnd)

  // Attach models + tokens to headers, then build search docs.
  const headers: TurnHeader[] = turns.map((turn, index) => {
    const header = headerFromTurn(turn)
    const tokens = tokenByTurn.get(index)
    if (tokens) header.tokens = tokens
    turnToSearchDocs(turn, searchLimit, searchDocs)
    return header
  })

  const items = turns.reduce((sum, turn) => sum + turn.items.length, 0)
  const counts: SessionCounts = {
    turns: turns.length,
    items,
    userPrompts: turns.filter((turn) => turn.kind === 'prompt').length,
    toolCalls: turns.reduce((sum, turn) => sum + turn.items.filter((item) => item.k === 'tool').length, 0),
    agents: turns.reduce((sum, turn) => sum + turn.items.filter((item) => item.k === 'agent').length, 0),
    thinking: turns.reduce((sum, turn) => sum + turn.items.filter((item) => item.k === 'think').length, 0),
    attachments: turns.reduce((sum, turn) => sum + turn.items.filter((item) => item.k === 'attach').length, 0),
    system: turns.reduce((sum, turn) => sum + turn.items.filter((item) => item.k === 'sys').length, 0),
  }

  const manifest: SessionManifest = {
    version: SESSION_INDEX_VERSION,
    id: sessionMeta.sessionId || 'session',
    title,
    sessionId: sessionMeta.sessionId,
    cwd: sessionMeta.cwd,
    gitBranch: sessionMeta.gitBranch,
    cliVersion: sessionMeta.version,
    builtAt: new Date().toISOString(),
    sessionStart,
    sessionEnd,
    models: Array.from(models),
    lastPrompt,
    bridgeSessionId,
    prLinks,
    cost,
    counts,
    turnShardSize,
    turnShardCount: Math.max(1, Math.ceil(turns.length / turnShardSize)),
    turns: headers,
    agents: [],
  }

  const bytes = turns.reduce((sum, turn) => sum + turn.items.reduce((s, item) => s + itemBytes(item), 0), 0)

  return { manifest, turns, searchDocs, agentLinks: links, bytes }
}

export interface BuildAgentResult {
  header: AgentHeader
  items: SessionItem[]
  searchDoc: SearchDoc
  links: Map<string, AgentLink>
}

export function buildAgentIndex(agentId: string, records: unknown[], link?: AgentLink, options: BuildMainOptions = {}): BuildAgentResult {
  const searchLimit = options.searchLimit ?? 2000
  const items: SessionItem[] = []
  const state: BuildState = { items, toolIndex: new Map() }
  const links = new Map<string, AgentLink>()
  const tools: Record<string, number> = {}
  let tsStart: string | undefined
  let tsEnd: string | undefined
  let task = ''
  let finalText = ''
  let model: string | undefined
  const attachmentPreviewLimit = options.attachmentPreviewLimit ?? 600

  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const type = record.type
    const ts = typeof record.timestamp === 'string' ? record.timestamp : undefined
    if (ts) {
      if (!tsStart) tsStart = ts
      tsEnd = ts
    }

    if (type === 'user') {
      const message = record.message as { content?: unknown } | undefined
      const content = message?.content
      if (typeof content === 'string') {
        if (!task) task = stripSystemReminders(content)
        else if (!content.startsWith('<')) pushItem(state, { k: 'prompt', ts, text: stripSystemReminders(content) })
        continue
      }
      if (Array.isArray(content)) {
        const hasToolResult = content.some((block) => block && typeof block === 'object' && ((block as Record<string, unknown>).type === 'tool_result' || (block as Record<string, unknown>).tool_use_id))
        if (hasToolResult) {
          applyToolResults(state, content, ts, record.toolUseResult, links, agentId)
        } else {
          const text = content
            .filter(isTextBlock)
            .map((block) => block.text)
            .join('\n')
          if (text) pushItem(state, { k: 'prompt', ts, text })
        }
        continue
      }
      continue
    }

    if (type === 'assistant') {
      const message = record.message as { content?: unknown; model?: string } | undefined
      if (message?.model) model = message.model
      renderAssistantContent(state, message?.content, ts, links)
      continue
    }

    if (type === 'attachment') {
      const attachment = (record.attachment as Record<string, unknown>) || {}
      renderAttachment(state, attachment, attachmentPreviewLimit, ts)
      continue
    }
  }

  for (const item of items) {
    if (item.k === 'tool' || item.k === 'agent') {
      const name = item.name || 'tool'
      tools[name] = (tools[name] || 0) + 1
    }
    if (item.k === 'text') finalText = item.text || finalText
  }

  const header: AgentHeader = {
    id: agentId,
    parentId: link?.parentId ?? null,
    subagentType: link?.subagentType,
    description: link?.description,
    model: link?.model || model,
    status: link?.status,
    isAsync: link?.isAsync,
    tsStart,
    tsEnd,
    task: truncate(task.replace(/\s+/g, ' '), 240),
    finalText: truncate(finalText.replace(/\s+/g, ' '), 240),
    tools,
    itemCount: items.length,
    bytes: items.reduce((sum, item) => sum + itemBytes(item), 0),
  }

  const searchDoc: SearchDoc = {
    id: `a:${agentId}`,
    kind: 'agent',
    agent: agentId,
    label: `Agent · ${header.description || header.subagentType || agentId}`,
    text: truncate([header.description, header.task, finalText].filter(Boolean).join('\n'), searchLimit),
  }

  return { header, items, searchDoc, links }
}

export function shardTurns(turns: Turn[], size: number): TurnShard[] {
  const shards: TurnShard[] = []
  for (let i = 0; i < turns.length; i += size) {
    shards.push({ shard: Math.floor(i / size), turns: turns.slice(i, i + size) })
  }
  return shards
}
