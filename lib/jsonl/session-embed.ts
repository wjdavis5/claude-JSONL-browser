import { createHash } from 'node:crypto'
import { VECTOR_DIMS } from './session-db.ts'

/** Bump when the chunking/extraction logic changes so vectors are re-derived. */
export const CHUNKER_VERSION = 1

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function contentHash(parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\u0000')
  return hash.digest('hex')
}

export interface Embedder {
  model: string
  dims: number
  /** Embed document text (ingest). */
  embed(texts: string[]): Promise<Float32Array[]>
  /** Embed a retrieval query (embeddinggemma's query role prompt). */
  embedQuery?(text: string): Promise<Float32Array>
}

export function truncateAndNormalize(vector: ArrayLike<number>, dims: number): Float32Array {
  const out = new Float32Array(dims)
  let sum = 0
  for (let i = 0; i < dims; i += 1) {
    const value = vector[i] ?? 0
    out[i] = value
    sum += value * value
  }
  const norm = Math.sqrt(sum) || 1
  for (let i = 0; i < dims; i += 1) out[i] /= norm
  return out
}

export interface LmStudioOptions {
  baseUrl?: string
  model?: string
  dims?: number
}

/**
 * LM Studio OpenAI-compatible embedder. Sends documents with embeddinggemma's
 * document role prompt and returns L2-normalized, Matryoshka-truncated vectors.
 */
export function createLmStudioEmbedder(options: LmStudioOptions = {}): Embedder {
  const baseUrl = (options.baseUrl ?? 'http://localhost:1234').replace(/\/$/, '')
  const model = options.model ?? 'text-embedding-embeddinggemma-2'
  const dims = options.dims ?? VECTOR_DIMS
  const BATCH = 16
  return {
    model,
    dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const vectors: Float32Array[] = []
      for (let i = 0; i < texts.length; i += BATCH) {
        vectors.push(...(await embedBatch(texts.slice(i, i + BATCH).map((text) => `title: none | text: ${text}`))))
      }
      return vectors
    },
    async embedQuery(text: string): Promise<Float32Array> {
      return (await embedBatch([`task: search result | query: ${text}`]))[0]
    },
  }

  async function embedBatch(inputs: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }),
    })
    if (!response.ok) throw new Error(`LM Studio embeddings failed: ${response.status}`)
    const json = (await response.json()) as { data: Array<{ index?: number; embedding: number[] }> }
    if (!json.data?.length) throw new Error('LM Studio returned no embedding')
    return json.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((entry) => truncateAndNormalize(entry.embedding, dims))
  }
}
