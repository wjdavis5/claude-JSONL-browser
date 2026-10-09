/**
 * Parses a retrieval hit's viewer jump target (`t<turn>:<item>` or `a:<agentId>`)
 * into the view the `/sessions` viewer should open.
 */
export function parseParentId(id: string): { turn: number; item: number } | { agent: string } | null {
  if (id.startsWith('a:')) return { agent: id.slice(2) }
  if (id.startsWith('t')) {
    const [turnRaw, itemRaw] = id.slice(1).split(':')
    const turn = Number(turnRaw)
    const item = Number(itemRaw)
    if (Number.isInteger(turn) && Number.isInteger(item)) return { turn, item }
  }
  return null
}
