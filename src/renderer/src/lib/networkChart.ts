export interface NetworkPoint {
  t: number
  rx: number | null
  tx: number | null
}

// The session sampler runs every 3 seconds; allow 1.5 seconds of scheduling jitter.
const MAX_CONTINUOUS_GAP_MS = 4500

/** Keep measured points solid and bridge missing observations with separate dashed series. */
export function networkChart(history: NetworkPoint[]): {
  points: Record<string, number | null>[]
  bridges: { key: string; series: 'rx' | 'tx' }[]
} {
  const points: Record<string, number | null>[] = []
  for (const point of history) {
    const previous = points.at(-1)
    if (previous && point.t - previous.t! > MAX_CONTINUOUS_GAP_MS) {
      points.push({ t: (previous.t! + point.t) / 2, rx: null, tx: null })
    }
    points.push({ ...point })
  }
  const bridges: { key: string; series: 'rx' | 'tx' }[] = []
  for (const series of ['rx', 'tx'] as const) {
    let previous: number | null = null
    points.forEach((point, index) => {
      if (point[series] === null) return
      if (previous !== null && index > previous + 1) {
        const key = `${series}Gap${bridges.length}`
        points[previous][key] = points[previous][series]
        point[key] = point[series]
        bridges.push({ key, series })
      }
      previous = index
    })
  }
  return { points, bridges }
}
