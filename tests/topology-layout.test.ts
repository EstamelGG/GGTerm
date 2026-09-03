import { expect, it } from 'vitest'
import { layoutTopology } from '../src/renderer/src/components/ai/topology/layout'

it('keeps positions stable when connection insertion order changes', () => {
  const a = layoutTopology([['jump', 'a'], ['b'], ['jump', 'c']], 1, 1)
  const b = layoutTopology([['jump', 'c'], ['jump', 'a'], ['b']], 1, 1)
  expect(a).toEqual(b)
  expect(a.size).toBe(4)
})

it('reserves label space in dense graphs even at the smallest spacing', () => {
  const positions = [
    ...layoutTopology(
      Array.from({ length: 80 }, (_, i) => [`host-${i}`]),
      0.4,
      1.6
    ).values()
  ]
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      expect(
        Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y)
      ).toBeGreaterThanOrEqual(143.99)
    }
  }
})

it('separates long jump chains and handles an empty graph', () => {
  expect(layoutTopology([], 1, 1).size).toBe(0)
  const positions = [...layoutTopology([['a', 'b', 'c', 'd']], 0.4, 1).values()]
  positions.forEach((p, i) => {
    if (i)
      expect(
        Math.hypot(p.x, p.y) - Math.hypot(positions[i - 1].x, positions[i - 1].y)
      ).toBeGreaterThanOrEqual(120)
  })
})
