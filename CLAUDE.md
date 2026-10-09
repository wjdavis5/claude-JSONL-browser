# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

### Development
- `npm run dev` - Start development server on http://localhost:3000
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## Architecture

### Tech Stack
- **Framework**: Next.js 15 with App Router
- **Language**: TypeScript with strict mode enabled
- **Styling**: Tailwind CSS with custom Everforest dark theme colors
- **Icons**: Lucide React
- **State Management**: React useState hooks (no external state library)

### Key Components

**JsonlConverter.tsx** - Main application component that handles:
- Multi-file JSONL management with unique IDs
- File upload via drag & drop or button
- JSONL to Markdown conversion logic
- Search functionality across all loaded files
- File sorting (by date, name, size)
- Inline file renaming
- Export capabilities (individual or combined markdown)

### JSONL Conversion Logic

The converter specifically handles Codex conversation logs with:
- Session metadata extraction (sessionId, gitBranch, cwd)
- Message type handling: user, assistant, summary
- Special formatting for model changes via `/model` command
- Tool use formatting for assistant responses
- Timestamp preservation and formatting

### Theme System

Uses Everforest dark theme colors defined in tailwind.config.ts:
- Background levels: bg-dim through bg5
- Semantic colors: red, yellow, green, blue, aqua, purple
- Text colors: fg (primary), grey0-2 (secondary)

### File Structure Patterns
- Components use client-side rendering (`'use client'`)
- Utility functions centralized in lib/utils.ts
- Single-page application with all logic in JsonlConverter component
- The `/sessions` viewer is client-side and must keep working on a static host. A local SQLite database (built by `npm run index`) adds one optional route (`app/api/session`) for hybrid retrieval; when that route or LM Studio is unavailable the viewer falls back to the static lexical search.
## Session Index (preprocess + search)

Large Claude Code sessions (the main transcript plus every `subagents/agent-*.jsonl`) are
far too big to load into the browser. Instead, preprocess a session into a compact,
sharded index served statically from `public/sessions/`.

### Build an index

```bash
npm run index -- <session-dir-or-.jsonl> [--out public/sessions] [--shard 12] [--title "..."]
```

Output per session (`public/sessions/<sessionId>/`):

- `manifest.json` - metadata, turn headers, agent headers (small, always loaded)
- `search.json` - truncated search documents (loaded on demand)
- `turns/<n>.json` - turn bodies, sharded (fetched on demand)
- `agents/<id>.json` - one subagent transcript each (fetched on demand)

plus a `public/sessions/index.json` catalog. Generated data is gitignored.

### Code map

- `lib/jsonl/session-index.ts` - index types + pure transforms. No relative imports, so Node 24 can execute it via type stripping.
- `lib/jsonl/session-index-client.ts` - browser fetch + formatting helpers.
- `scripts/build-session-index.ts` - the CLI (`npm run index`), run directly by Node (needs `allowImportingTsExtensions` in tsconfig).
- `components/jsonl/SessionIndexViewer.tsx` - viewer shell: turns/agents/search tabs, lazy shards, keyboard nav (j/k), hash deep-links (`#turn/<n>`, `#agent/<id>`).
- `components/jsonl/SessionBlocks.tsx` - block renderer: prompts, assistant text, thinking, tool calls (input/output, collapsed with preview), subagent calls.
- `app/sessions/page.tsx` - `/sessions` route.

### Memory model

Only the manifest (~1-2 MB) and, on demand, the search docs (~10 MB) and one turn shard or
one agent transcript are ever in the browser at a time.

## Session Database (local hybrid search + graph)

`npm run index` can also build a SQLite session database (`data/session.db`, gitignored)
holding the full untruncated text, an FTS5 + `sqlite-vec` hybrid index, and a session
graph. Retrieval runs in Node (`app/api/session/[...path]`) and the browser calls it,
falling back to the static `search.json` scan when it is absent.

- Schema, graph, ingest, and retrieval: `lib/jsonl/session-db.ts`, `session-db-node.ts`, `session-embed.ts`, `session-ingest.ts`, `session-retrieve.ts`, `session-jump.ts`.
- Embeddings: local LM Studio (`/v1/embeddings`, model `text-embedding-embeddinggemma-2`), 768-dim truncated to 256 and L2-normalized, content-hash cached.
- Requires Node 24 (`node:sqlite` with FTS5 + `allowExtension`) and `sqlite-vec`; `next.config.mjs` lists `sqlite-vec` in `serverExternalPackages`.
- The database lives outside the served tree (`data/`) and is never served statically.
