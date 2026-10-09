'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
  Paperclip,
  Settings2,
  Terminal,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SessionItem } from '@/lib/jsonl/session-index'
import { itemText, toolSummary } from '@/lib/jsonl/session-index-client'

const RESULT_PREVIEW = 2400

export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let key = 0
  while (cursor < text.length) {
    const found = lower.indexOf(needle, cursor)
    if (found === -1) {
      parts.push(text.slice(cursor))
      break
    }
    if (found > cursor) parts.push(text.slice(cursor, found))
    parts.push(
      <mark key={key++} className="bg-everforest-yellow/40 text-everforest-fg rounded px-0.5">
        {text.slice(found, found + needle.length)}
      </mark>,
    )
    cursor = found + needle.length
  }
  return <>{parts}</>
}

function Chip({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' }) {
  const tones: Record<string, string> = {
    default: 'bg-everforest-bg2 text-everforest-grey2 border-everforest-bg4',
    blue: 'bg-everforest-bg-blue text-everforest-blue border-everforest-blue/30',
    green: 'bg-everforest-bg-green text-everforest-green border-everforest-green/30',
    yellow: 'bg-everforest-bg-yellow text-everforest-yellow border-everforest-yellow/30',
    red: 'bg-everforest-bg-red text-everforest-red border-everforest-red/30',
    purple: 'bg-everforest-bg-visual text-everforest-purple border-everforest-purple/30',
  }
  return <span className={cn('px-1.5 py-0.5 rounded border text-[11px] font-medium whitespace-nowrap', tones[tone])}>{children}</span>
}

function Collapsible({
  title,
  icon,
  defaultOpen = false,
  tone,
  right,
  preview,
  children,
}: {
  title: React.ReactNode
  icon: React.ReactNode
  defaultOpen?: boolean
  tone?: 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'purple'
  right?: React.ReactNode
  preview?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const border: Record<string, string> = {
    default: 'border-everforest-bg4',
    blue: 'border-everforest-blue/30',
    green: 'border-everforest-green/30',
    yellow: 'border-everforest-yellow/30',
    red: 'border-everforest-red/40',
    purple: 'border-everforest-purple/30',
  }
  return (
    <div className={cn('rounded-lg border bg-everforest-bg1/60 overflow-hidden', border[tone || 'default'])}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-everforest-bg2/60 transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-everforest-grey1 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-everforest-grey1 flex-shrink-0" />}
        <span className="flex-shrink-0">{icon}</span>
        <span className="flex-1 min-w-0 text-sm text-everforest-fg truncate">{title}</span>
        {right}
      </button>
      {!open && preview && <div className="px-3 pb-2 -mt-0.5 pl-9">{preview}</div>}
      {open && <div className="px-3 pb-3 pt-1 border-t border-everforest-bg4/60">{children}</div>}
    </div>
  )
}

function Pre({ text, query }: { text: string; query: string }) {
  const [expanded, setExpanded] = useState(false)
  const truncated = text.length > RESULT_PREVIEW && !expanded
  const shown = truncated ? text.slice(0, RESULT_PREVIEW) : text
  return (
    <div>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-everforest-grey2 max-h-[520px] overflow-auto custom-scrollbar">
        <Highlight text={shown} query={query} />
      </pre>
      {text.length > RESULT_PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-xs text-everforest-blue hover:underline"
        >
          {expanded ? 'Show less' : `Show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  )
}

function Json({ value, query }: { value: unknown; query: string }) {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return <Pre text={text} query={query} />
}

export function SessionItemView({
  item,
  query,
  onOpenAgent,
  highlighted = false,
}: {
  item: SessionItem
  query: string
  onOpenAgent?: (agentId: string) => void
  highlighted?: boolean
}) {
  const ring = highlighted ? 'ring-2 ring-everforest-yellow/50 rounded-lg' : ''

  if (item.k === 'prompt') {
    return (
      <div className={cn('rounded-lg border border-everforest-green/30 bg-everforest-bg-green/30 px-4 py-3', ring)}>
        <div className="flex items-center gap-2 mb-1.5">
          <Chip tone="green">User</Chip>
          {item.ts && <span className="text-[11px] text-everforest-grey1">{new Date(item.ts).toLocaleTimeString()}</span>}
        </div>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-everforest-fg">
          <Highlight text={item.text || ''} query={query} />
        </pre>
      </div>
    )
  }

  if (item.k === 'text') {
    return (
      <div className={cn('px-1', ring)}>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-everforest-fg">
          <Highlight text={item.text || ''} query={query} />
        </pre>
      </div>
    )
  }

  if (item.k === 'think') {
    return (
      <div className={ring}>
        <Collapsible
          title={<span className="italic text-everforest-grey2">Thinking</span>}
          icon={<Brain className="w-4 h-4 text-everforest-purple" />}
          tone="purple"
        >
          <pre className="whitespace-pre-wrap break-words font-sans text-xs italic leading-relaxed text-everforest-grey2">
            <Highlight text={item.text || ''} query={query} />
          </pre>
        </Collapsible>
      </div>
    )
  }

  if (item.k === 'compact') {
    return (
      <div className={cn('rounded-lg border border-everforest-purple/30 bg-everforest-bg-visual/30 px-4 py-3', ring)}>
        <div className="flex items-center gap-2 mb-1.5">
          <Chip tone="purple">Context compaction</Chip>
        </div>
        <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-everforest-grey2">
          <Highlight text={item.text || ''} query={query} />
        </pre>
      </div>
    )
  }

  if (item.k === 'agent') {
    const result = item.result || ''
    return (
      <div className={cn('rounded-lg border border-everforest-aqua/40 bg-everforest-bg1/70 overflow-hidden', ring)}>
        <div className="px-3 py-2 border-b border-everforest-bg4/60 flex items-center gap-2 flex-wrap">
          <Bot className="w-4 h-4 text-everforest-aqua flex-shrink-0" />
          <span className="text-sm font-medium text-everforest-fg">Subagent</span>
          {item.subagentType && <Chip tone="blue">{item.subagentType}</Chip>}
          {item.meta?.resolvedModel ? <Chip>{String(item.meta.resolvedModel)}</Chip> : null}
          {item.meta?.status ? <Chip tone={item.meta.status === 'completed' ? 'green' : 'yellow'}>{String(item.meta.status)}</Chip> : null}
          {item.meta?.isAsync ? <Chip tone="yellow">async</Chip> : null}
          <span className="flex-1" />
          {item.agentId && onOpenAgent && (
            <button
              type="button"
              onClick={() => onOpenAgent(item.agentId as string)}
              className="px-2 py-1 rounded bg-everforest-bg-blue text-everforest-blue border border-everforest-blue/30 text-xs hover:bg-everforest-bg-blue/70 transition-colors"
            >
              Open transcript
            </button>
          )}
        </div>
        <div className="px-3 py-2 space-y-2">
          {item.description && <div className="text-sm text-everforest-fg">{item.description}</div>}
          {item.input ? (
            <Collapsible title={<span className="text-everforest-grey1">Prompt</span>} icon={<FileText className="w-3.5 h-3.5 text-everforest-grey1" />}>
              <Json value={item.input} query={query} />
            </Collapsible>
          ) : null}
          {result && (
            <Collapsible
              title={<span className="text-everforest-grey1">Result</span>}
              icon={<Terminal className="w-3.5 h-3.5 text-everforest-grey1" />}
              tone={item.isError ? 'red' : 'default'}
            >
              <Pre text={result} query={query} />
            </Collapsible>
          )}
        </div>
      </div>
    )
  }

  if (item.k === 'tool') {
    const summary = toolSummary(item)
    const hasResult = Boolean(item.result && item.result.length > 0)
    const hasInput = item.input !== undefined && item.input !== null
    return (
      <div className={ring}>
        <Collapsible
          title={
            <span className="flex items-center gap-2 min-w-0">
              <span className="font-medium text-everforest-blue">{item.name || 'tool'}</span>
              {summary && <span className="text-everforest-grey1 truncate text-xs">{summary}</span>}
            </span>
          }
          icon={<Wrench className="w-3.5 h-3.5 text-everforest-blue" />}
          tone={item.isError ? 'red' : 'blue'}
          right={item.isError ? <AlertTriangle className="w-3.5 h-3.5 text-everforest-red" /> : undefined}
          preview={
            hasResult ? (
              <div className="text-xs text-everforest-grey1 font-mono truncate">
                <Highlight text={(item.result || '').split('\n').slice(0, 3).join(' ⏎ ').slice(0, 220)} query={query} />
              </div>
            ) : undefined
          }
        >
          <div className="space-y-2">
            {item.meta && Object.keys(item.meta).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.entries(item.meta).map(([key, value]) => (
                  <Chip key={key}>
                    {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                  </Chip>
                ))}
              </div>
            )}
            {hasInput && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-everforest-grey1 mb-1">Input</div>
                <Json value={item.input} query={query} />
              </div>
            )}
            {hasResult && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-everforest-grey1 mb-1">
                  {item.isError ? 'Error' : 'Output'}
                </div>
                <Pre text={item.result || ''} query={query} />
              </div>
            )}
            {!hasInput && !hasResult && <div className="text-xs text-everforest-grey1">No payload recorded.</div>}
          </div>
        </Collapsible>
      </div>
    )
  }

  if (item.k === 'note') {
    return (
      <div className={cn('flex items-start gap-2 text-xs text-everforest-grey1 px-1', ring)}>
        <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-everforest-grey0" />
        <span className="whitespace-pre-wrap break-words">
          <Highlight text={item.text || ''} query={query} />
        </span>
      </div>
    )
  }

  if (item.k === 'attach') {
    return (
      <div className={ring}>
        <Collapsible
          title={<span className="text-everforest-grey1 text-xs">Attachment · {String(item.meta?.attType || '')}</span>}
          icon={<Paperclip className="w-3.5 h-3.5 text-everforest-grey0" />}
        >
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-everforest-grey2 max-h-80 overflow-auto custom-scrollbar">
            <Highlight text={itemText(item)} query={query} />
          </pre>
        </Collapsible>
      </div>
    )
  }

  if (item.k === 'sys') {
    return (
      <div className={cn('flex items-center gap-2 text-[11px] text-everforest-grey0 px-1', ring)}>
        <Settings2 className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">{item.text}</span>
      </div>
    )
  }

  return null
}

export function SessionItems({
  items,
  query,
  onOpenAgent,
  highlightIndex,
}: {
  items: SessionItem[]
  query: string
  onOpenAgent?: (agentId: string) => void
  highlightIndex?: number
}) {
  const highlightRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlightIndex === undefined) return
    const timer = window.setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    return () => window.clearTimeout(timer)
  }, [highlightIndex])

  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={index} data-item-index={index} ref={highlightIndex === index ? highlightRef : undefined}>
          <SessionItemView item={item} query={query} onOpenAgent={onOpenAgent} highlighted={highlightIndex === index} />
        </div>
      ))}
    </div>
  )
}
