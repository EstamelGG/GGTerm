import { describe, expect, it } from 'vitest'
import {
  boundSnapshot,
  snapshotFeedback,
  SNAPSHOT_BYTES,
  type PageSnapshot
} from '../src/main/browserSnapshot'
const page = (elements: PageSnapshot['elements'] = []): PageSnapshot => ({
  url: 'https://example.test/',
  title: 'Test',
  content: 'Page',
  elements,
  frames: [],
  total: elements.length,
  offset: 0,
  nextOffset: null,
  truncated: false
})
describe('bounded browser feedback', () => {
  it('returns only a checkbox change, then unchanged, retaining stable refs', () => {
    const previous = page([
      { ref: '1', checked: false },
      { ref: '2', name: 'Save' }
    ])
    const current = page([
      { ref: '1', checked: true },
      { ref: '2', name: 'Save' }
    ])
    expect(snapshotFeedback(current, previous)).toMatchObject({
      snapshot: 'delta',
      elements: [{ ref: '1', checked: true }]
    })
    expect(snapshotFeedback(current, previous)).not.toHaveProperty('content')
    expect(snapshotFeedback(current, current)).toMatchObject({
      snapshot: 'unchanged',
      elements: []
    })
  })
  it('reports removals and navigation returns a full view', () => {
    const previous = page([{ ref: '1' }])
    expect(snapshotFeedback(page(), previous)).toMatchObject({ removedRefs: ['1'] })
    expect(
      snapshotFeedback({ ...page(), url: 'https://example.test/new' }, previous)
    ).toMatchObject({ snapshot: 'full' })
  })
  it('bounds serialized UTF-8 output, preserving a usable pagination cursor', () => {
    const source = page(
      Array.from({ length: 200 }, (_, i) => ({
        ref: String(i),
        context: '很长的表格内容'.repeat(100)
      }))
    )
    source.content = '正文'.repeat(6000)
    const bounded = boundSnapshot(source)
    expect(Buffer.byteLength(JSON.stringify(snapshotFeedback(bounded)))).toBeLessThanOrEqual(
      SNAPSHOT_BYTES
    )
    expect(bounded.nextOffset).toBe(bounded.elements.length)
    expect(bounded.truncated).toBe(true)
    expect(bounded.elements.length).toBeGreaterThan(0)
    expect(bounded.elements.length).toBeLessThan(200)
  })
  it('one enormous element cannot stall pagination', () => {
    const bounded = boundSnapshot(
      page([{ ref: '1', name: 'Select', options: ['x'.repeat(100000)] }, { ref: '2' }])
    )
    expect(bounded.elements[0]).toMatchObject({ ref: '1', detailsOmitted: true })
    expect(bounded.nextOffset).toBe(1)
  })
})
