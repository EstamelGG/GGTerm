/** Bound page feedback before it enters the conversation, then diff the delivered view. */
export interface PageSnapshot {
  url: string
  title: string
  content: string
  elements: Array<{ ref: string; [key: string]: unknown }>
  frames: unknown[]
  total: number
  offset: number
  nextOffset: number | null
  truncated: boolean
  [key: string]: unknown
}

export const SNAPSHOT_BYTES = 24000
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

export function boundSnapshot(source: PageSnapshot): PageSnapshot {
  // Bounds apply to the whole serialized response, including repeated row context.
  const result: PageSnapshot = { ...source, elements: [], frames: [] }
  result.content = source.content.slice(0, 4000)
  result.title = source.title.slice(0, 300)
  result.url = source.url.slice(0, 2000)
  for (const frame of source.frames) {
    result.frames.push(frame)
    if (bytes(result) > SNAPSHOT_BYTES / 2) {
      result.frames.pop()
      result.framesTruncated = true
      break
    }
  }
  for (const element of source.elements) {
    result.elements.push(element)
    if (bytes(result) > SNAPSHOT_BYTES - 512) {
      result.elements.pop()
      break
    }
  }
  // Even a single unusually large select/label must not prevent pagination.
  if (!result.elements.length && source.elements.length) {
    const first = source.elements[0]
    result.elements.push({
      ref: first.ref,
      name: String(first.name ?? '').slice(0, 100),
      detailsOmitted: true
    })
  }
  result.nextOffset =
    result.offset + result.elements.length < result.total
      ? result.offset + result.elements.length
      : null
  result.truncated = result.nextOffset !== null
  result.contentTruncated = source.content.length > result.content.length
  return result
}

export function snapshotFeedback(current: PageSnapshot, previous?: PageSnapshot): unknown {
  if (!previous || current.url !== previous.url) return { ...current, snapshot: 'full' }
  const old = new Map(previous.elements.map((element) => [element.ref, element]))
  const refs = new Set(current.elements.map((element) => element.ref))
  const changed = current.elements.filter(
    (element) => JSON.stringify(old.get(element.ref)) !== JSON.stringify(element)
  )
  const removedRefs = previous.elements
    .filter((element) => !refs.has(element.ref))
    .map((element) => element.ref)
  const { content, frames, ...meta } = current
  const changedContent = content !== previous.content
  const changedFrames = JSON.stringify(frames) !== JSON.stringify(previous.frames)
  const unchanged =
    !changed.length &&
    !removedRefs.length &&
    !changedContent &&
    !changedFrames &&
    current.title === previous.title &&
    current.total === previous.total
  const delta = {
    ...meta,
    snapshot: unchanged ? 'unchanged' : 'delta',
    elements: changed,
    ...(removedRefs.length ? { removedRefs } : {}),
    ...(changedContent ? { content } : {}),
    ...(changedFrames ? { frames } : {})
  }
  return bytes(delta) <= SNAPSHOT_BYTES ? delta : { ...current, snapshot: 'full' }
}
