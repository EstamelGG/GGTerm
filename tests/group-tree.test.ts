import { expect, it } from 'vitest'
import { descendantsOf, flattenGroups } from '../src/shared/groupTree'
import type { HostGroup } from '../src/shared/types'

const group = (id: string, parentId: string | null, sort = 0): HostGroup => ({
  id,
  parentId,
  name: id,
  sort,
  colorHex: '#fff'
})
it('preserves sorted depth-first order without mutating input', () => {
  const groups = [group('b', null, 2), group('c', 'a'), group('a', null, 1), group('d', 'c')]
  expect(flattenGroups(groups).map(({ group, depth }) => [group.id, depth])).toEqual([
    ['a', 0],
    ['c', 1],
    ['d', 2],
    ['b', 0]
  ])
  expect(groups.map((g) => g.id)).toEqual(['b', 'c', 'a', 'd'])
  expect(descendantsOf('a', groups)).toEqual(new Set(['c', 'd']))
})
it('handles deep trees and malformed cycles without overflowing or looping', () => {
  const deep = Array.from({ length: 12000 }, (_, i) => group(String(i), i ? String(i - 1) : null))
  expect(flattenGroups(deep).at(-1)?.depth).toBe(11999)
  expect(descendantsOf('0', deep).size).toBe(11999)
  expect(descendantsOf('a', [group('a', 'b'), group('b', 'a')])).toEqual(new Set(['b']))
  expect(
    flattenGroups([group('a', null), group('b', 'a'), group('a', 'b')]).map((r) => r.group.id)
  ).toEqual(['a', 'b'])
})
