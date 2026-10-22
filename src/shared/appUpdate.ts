export interface AppUpdateResult {
  currentVersion: string
  latestVersion: string
  available: boolean
  url: string
  notes: string
}

/** Releases use stable SemVer tags; build metadata does not affect precedence. */
export function isNewerRelease(latest: string, current: string): boolean {
  const stable = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z.-]+)?$/
  const installed =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/
  const a = stable.exec(latest)
  const b = installed.exec(current)
  if (!a || !b) throw new Error('Invalid release version')
  for (let i = 1; i <= 3; i++) {
    const left = BigInt(a[i])
    const right = BigInt(b[i])
    if (left !== right) return left > right
  }
  return Boolean(b[4])
}
