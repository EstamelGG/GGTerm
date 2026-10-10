import { expect, it } from 'vitest'
import { networkChart } from '../src/renderer/src/lib/networkChart'

it('keeps regular observations continuous, including measured zero speeds', () => {
  const points = [
    { t: 0, rx: 0, tx: 10 },
    { t: 3000, rx: 20, tx: 0 }
  ]
  expect(networkChart(points)).toEqual({ points, bridges: [] })
})

it('bridges a silent sampling interval without fabricating speed values', () => {
  const result = networkChart([
    { t: 0, rx: 10, tx: 20 },
    { t: 9000, rx: 30, tx: 40 }
  ])
  expect(result.points[1]).toEqual({ t: 4500, rx: null, tx: null })
  expect(result.bridges.map((bridge) => bridge.series)).toEqual(['rx', 'tx'])
  for (const { key, series } of result.bridges) {
    expect(result.points[0][key]).toBe(result.points[0][series])
    expect(result.points[2][key]).toBe(result.points[2][series])
    expect(result.points[1][key]).toBeUndefined()
  }
})

it('bridges only the missing direction and leaves leading/trailing gaps unfilled', () => {
  const result = networkChart([
    { t: 0, rx: null, tx: 2 },
    { t: 3000, rx: 10, tx: 3 },
    { t: 6000, rx: null, tx: 4 },
    { t: 9000, rx: 20, tx: 5 },
    { t: 12000, rx: null, tx: 6 }
  ])
  expect(result.bridges).toHaveLength(1)
  expect(result.bridges[0].series).toBe('rx')
  expect(result.points.map((point) => point.rx)).toEqual([null, 10, null, 20, null])
  expect(result.points[0][result.bridges[0].key]).toBeUndefined()
  expect(result.points[4][result.bridges[0].key]).toBeUndefined()
})
