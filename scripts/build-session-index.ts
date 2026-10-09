#!/usr/bin/env node
/**
 * Build a compact, searchable index for a Claude Code session.
 *
 * Usage:
 *   node scripts/build-session-index.ts <input> [--out <dir>] [--title <t>] [--shard <n>] [--limit-agents <n>]
 *
 * <input> may be either:
 *   - a session directory containing `<uuid>.jsonl` and an optional `subagents/` folder, or
 *   - a single `<uuid>.jsonl` file (its sibling `subagents/` folder is used if present).
 *
 * Output (under <out>/<sessionId>/):
 *   manifest.json        small: metadata + turn headers + agent headers
 *   search.json          compact search documents (truncated)
 *   turns/<n>.json       turn bodies, sharded (fetched on demand)
 *   agents/<id>.json     subagent transcripts (fetched on demand)
 * and a catalog at <out>/index.json listing every built session.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  buildAgentIndex,
  buildMainIndex,
  SESSION_INDEX_VERSION,
  shardTurns,
  type AgentHeader,
  type AgentLink,
  type SearchDoc,
  type SessionCatalog,
  type SessionCatalogEntry,
  type SessionManifest,
} from '../lib/jsonl/session-index.ts'
import { openDatabase } from '../lib/jsonl/session-db-node.ts'
import { extractSessionGraph, type GraphItem } from '../lib/jsonl/session-db.ts'
import { ingestSession, type IngestItem } from '../lib/jsonl/session-ingest.ts'
import { createLmStudioEmbedder } from '../lib/jsonl/session-embed.ts'

interface Args {
  input: string
  out: string
  title?: string
  shard: number
  limitAgents: number
  noDb: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { input: '', out: '', shard: 12, limitAgents: 0, noDb: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--out') args.out = argv[++i]
    else if (token === '--title') args.title = argv[++i]
    else if (token === '--shard') args.shard = Number(argv[++i]) || 12
    else if (token === '--limit-agents') args.limitAgents = Number(argv[++i]) || 0
    else if (token === '--no-db') args.noDb = true
    else rest.push(token)
  }
  args.input = rest[0] || ''
  if (!args.input) {
    console.error('Missing <input>. See header for usage.')
    process.exit(1)
  }
  if (!args.out) args.out = join(process.cwd(), 'public', 'sessions')
  return args
}

function readJsonl(path: string): unknown[] {
  const text = readFileSync(path, 'utf8')
  const records: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      /* skip malformed line */
    }
  }
  return records
}

/**
 * Locates the subagents folder for a main transcript. Claude Code has shipped
 * two layouts:
 *   <dir>/<uuid>.jsonl  +  <dir>/subagents/
 *   <dir>/<uuid>.jsonl  +  <dir>/<uuid>/subagents/
 */
function findSubagentsDir(mainPath: string, sessionId: string): string | null {
  const parent = dirname(mainPath)
  const candidates = [join(parent, 'subagents'), join(parent, sessionId, 'subagents'), join(parent, 'agents')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }
  return null
}

function resolveInputs(input: string): { mainPath: string; subagentsDir: string | null; sessionId: string } {
  const absolute = resolve(input)
  const stats = statSync(absolute)
  if (stats.isDirectory()) {
    const entries = readdirSync(absolute).filter((name) => name.endsWith('.jsonl'))
    if (entries.length === 0) throw new Error(`No .jsonl file found in ${absolute}`)
    // Prefer the largest jsonl (the main transcript).
    entries.sort((a, b) => statSync(join(absolute, b)).size - statSync(join(absolute, a)).size)
    const mainPath = join(absolute, entries[0])
    const sessionId = basename(mainPath, '.jsonl')
    return { mainPath, subagentsDir: findSubagentsDir(mainPath, sessionId), sessionId }
  }
  const sessionId = basename(absolute, '.jsonl')
  return { mainPath: absolute, subagentsDir: findSubagentsDir(absolute, sessionId), sessionId }
}

function collectAgentFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  walk(dir)
  return files
}

function agentIdFromFile(path: string): string {
  return basename(path, '.jsonl').replace(/^agent-/, '')
}

function writeJson(path: string, value: unknown): number {
  mkdirSync(dirname(path), { recursive: true })
  const json = JSON.stringify(value)
  writeFileSync(path, json)
  return Buffer.byteLength(json)
}

async function buildDatabase(sessionId: string, items: IngestItem[], manifest: SessionManifest): Promise<void> {
  const dbPath = join(process.cwd(), 'data', 'session.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const { db, vecAvailable } = openDatabase(dbPath)
  try {
    db.prepare(
      'INSERT OR REPLACE INTO sessions(id, title, git_branch, cwd, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sessionId, manifest.title ?? null, manifest.gitBranch ?? null, manifest.cwd ?? null, manifest.sessionStart ?? null, manifest.sessionEnd ?? null)

    const graph = extractSessionGraph(
      sessionId,
      items.map((item) => ({ item: item as unknown as GraphItem, parentId: item.parentId })),
    )
    const insertNode = db.prepare('INSERT OR REPLACE INTO nodes(id, kind, props) VALUES (?, ?, ?)')
    for (const node of graph.nodes) insertNode.run(node.id, node.kind, node.props ? JSON.stringify(node.props) : null)
    const insertEdge = db.prepare('INSERT OR IGNORE INTO edges(from_id, to_id, type, props) VALUES (?, ?, ?, ?)')
    for (const edge of graph.edges) insertEdge.run(edge.from, edge.to, edge.type, edge.props ? JSON.stringify(edge.props) : null)

    if (!vecAvailable) {
      console.log('[index] db       sqlite-vec unavailable; skipping ingest')
      return
    }
    const stats = await ingestSession(db, { sessionId, items, embedder: createLmStudioEmbedder() })
    console.log(
      `[index] db       chunks ${stats.chunks} · embedded ${stats.embedded} · reused ${stats.reused} · partial ${stats.partial} · nodes ${graph.nodes.length} · edges ${graph.edges.length}`,
    )
  } finally {
    db.close()
  }
}

async function main() {
  const started = Date.now()
  const args = parseArgs(process.argv.slice(2))
  const { mainPath, subagentsDir, sessionId } = resolveInputs(args.input)
  const outRoot = resolve(args.out)
  const outDir = join(outRoot, sessionId)

  console.log(`[index] session  ${sessionId}`)
  console.log(`[index] main     ${mainPath}`)
  console.log(`[index] subagents ${subagentsDir || '(none)'}`)

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const mainRecords = readJsonl(mainPath)
  const main = buildMainIndex(mainRecords, { turnShardSize: args.shard })
  if (args.title) main.manifest.title = args.title

  const allLinks = new Map<string, AgentLink>(main.agentLinks)

  // Pass 1: agent bodies + links (streamed to keep memory bounded).
  const agentHeaders: AgentHeader[] = []
  const searchDocs: SearchDoc[] = [...main.searchDocs]
  const agentItems: IngestItem[] = []
  let agentCount = 0
  if (subagentsDir) {
    let files = collectAgentFiles(subagentsDir)
    if (args.limitAgents > 0) files = files.slice(0, args.limitAgents)
    console.log(`[index] agents   ${files.length}`)
    for (const file of files) {
      const id = agentIdFromFile(file)
      try {
        const records = readJsonl(file)
        const built = buildAgentIndex(id, records, allLinks.get(id))
        for (const [childId, link] of built.links) {
          if (!allLinks.has(childId)) allLinks.set(childId, link)
        }
        writeJson(join(outDir, 'agents', `${id}.json`), { id, header: built.header, items: built.items })
        built.items.forEach((item, index) => {
          agentItems.push({ parentId: `a:${id}:${index}`, kind: item.k, name: item.name, input: item.input, result: item.result, text: item.text })
        })
        agentHeaders.push(built.header)
        searchDocs.push(built.searchDoc)
        agentCount += 1
        if (agentCount % 200 === 0) console.log(`[index]   ...${agentCount}/${files.length}`)
      } catch (error) {
        console.warn(`[index] failed agent ${id}: ${(error as Error).message}`)
      }
    }
  }

  // Pass 2: reconcile parent/type/description from every observed link.
  for (const header of agentHeaders) {
    const link = allLinks.get(header.id)
    if (!link) continue
    header.parentId = link.parentId
    header.subagentType = header.subagentType || link.subagentType
    header.description = header.description || link.description
    header.model = header.model || link.model
    header.status = header.status || link.status
    header.isAsync = header.isAsync ?? link.isAsync
  }
  agentHeaders.sort((a, b) => (a.tsStart || '').localeCompare(b.tsStart || ''))

  main.manifest.agents = agentHeaders
  main.manifest.counts.agents = agentHeaders.length

  // Write turn shards.
  const shards = shardTurns(main.turns, args.shard)
  for (const shard of shards) {
    writeJson(join(outDir, 'turns', `${shard.shard}.json`), shard)
  }

  const manifestBytes = writeJson(join(outDir, 'manifest.json'), main.manifest)
  const searchBytes = writeJson(join(outDir, 'search.json'), { version: SESSION_INDEX_VERSION, docs: searchDocs })

  const bodyBytes = main.bytes + agentHeaders.reduce((sum, header) => sum + header.bytes, 0)
  const entry: SessionCatalogEntry = {
    id: sessionId,
    title: main.manifest.title,
    builtAt: main.manifest.builtAt,
    counts: main.manifest.counts,
    models: main.manifest.models,
    sessionStart: main.manifest.sessionStart,
    sessionEnd: main.manifest.sessionEnd,
    bytes: bodyBytes,
  }

  // Update catalog.
  const catalogPath = join(outRoot, 'index.json')
  let catalog: SessionCatalog = { version: SESSION_INDEX_VERSION, sessions: [] }
  if (existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
    } catch {
      /* rebuild */
    }
  }
  catalog.version = SESSION_INDEX_VERSION
  catalog.sessions = catalog.sessions.filter((s) => s.id !== sessionId)
  catalog.sessions.push(entry)
  catalog.sessions.sort((a, b) => (b.sessionStart || '').localeCompare(a.sessionStart || ''))
  writeJson(catalogPath, catalog)

  if (!args.noDb) {
    const mainItems: IngestItem[] = []
    for (const turn of main.turns) {
      turn.items.forEach((item, index) => {
        mainItems.push({ parentId: `t${turn.i}:${index}`, kind: item.k, name: item.name, input: item.input, result: item.result, text: item.text })
      })
    }
    await buildDatabase(sessionId, [...mainItems, ...agentItems], main.manifest)
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `[index] done in ${seconds}s · turns ${main.manifest.counts.turns} · items ${main.manifest.counts.items} · ` +
      `tools ${main.manifest.counts.toolCalls} · agents ${agentHeaders.length} · ` +
      `manifest ${(manifestBytes / 1024).toFixed(0)}KB · search ${(searchBytes / 1e6).toFixed(1)}MB · ` +
      `shards ${shards.length}`,
  )
  console.log(`[index] output ${outDir}`)
}

main().catch((error) => {
  console.error('[index] fatal:', error)
  process.exit(1)
})
