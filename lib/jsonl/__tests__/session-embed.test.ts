import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentHash, createLmStudioEmbedder, normalizeText, truncateAndNormalize } from '../session-embed'

afterEach(() => vi.restoreAllMocks())

describe('session-embed', () => {
  it('normalizes whitespace', () => {
    expect(normalizeText('  a\n\tb   c ')).toBe('a b c')
  })

  it('hashes deterministically and distinguishes different part boundaries', () => {
    expect(contentHash(['a', 'b'])).toBe(contentHash(['a', 'b']))
    expect(contentHash(['a', 'b'])).not.toBe(contentHash(['ab', '']))
  })

  it('truncates to dims and L2-normalizes', () => {
    const vector = truncateAndNormalize([3, 4, 5, 6], 2)
    expect(vector.length).toBe(2)
    expect(Math.hypot(vector[0], vector[1])).toBeCloseTo(1)
  })

  it('does not produce NaN for a zero vector', () => {
    const vector = truncateAndNormalize([0, 0], 2)
    expect(Number.isNaN(vector[0])).toBe(false)
    expect(Number.isNaN(vector[1])).toBe(false)
  })

  it('batches documents and orders results by response index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 }),
      ),
    )
    const embedder = createLmStudioEmbedder({ dims: 2 })
    const out = await embedder.embed(['first', 'second'])
    expect(out).toHaveLength(2)
    expect(out[0][0]).toBeCloseTo(1)
    expect(out[1][1]).toBeCloseTo(1)
  })

  it('throws when LM Studio returns a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const embedder = createLmStudioEmbedder({ dims: 2 })
    await expect(embedder.embed(['x'])).rejects.toThrow(/LM Studio/)
  })
})
