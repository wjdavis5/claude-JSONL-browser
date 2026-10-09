import { describe, expect, it } from 'vitest'
import { parseParentId } from '../session-jump'

describe('retrieval hit jump target', () => {
  it('parses a turn/item jump id', () => {
    expect(parseParentId('t12:3')).toEqual({ turn: 12, item: 3 })
  })

  it('parses an agent jump id', () => {
    expect(parseParentId('a:abc123')).toEqual({ agent: 'abc123' })
  })

  it('rejects an unparseable id', () => {
    expect(parseParentId('nonsense')).toBeNull()
    expect(parseParentId('tx:y')).toBeNull()
  })
})
