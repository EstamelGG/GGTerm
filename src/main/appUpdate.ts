import { app, ipcMain, net, shell } from 'electron'
import type { AppUpdateResult } from '../shared/appUpdate'
import { isNewerRelease } from '../shared/appUpdate'

const RELEASES = 'https://github.com/EstamelGG/GGTerm/releases'
const ENDPOINT = 'https://api.github.com/repos/EstamelGG/GGTerm/releases/latest'
let cached: { result: AppUpdateResult; time: number } | undefined
let pending: Promise<AppUpdateResult> | undefined

export function checkAppUpdate(): Promise<AppUpdateResult> {
  if (pending) return pending
  if (cached && Date.now() - cached.time < 60_000) return Promise.resolve(cached.result)
  pending = (async () => {
    const response = await net.fetch(ENDPOINT, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000)
    })
    if (response.status === 404) throw new Error('NO_RELEASE')
    if (response.status === 403 || response.status === 429) throw new Error('RATE_LIMITED')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const release = (await response.json()) as {
      tag_name?: unknown
      draft?: boolean
      prerelease?: boolean
      body?: unknown
      assets?: { state?: string; name?: string }[]
    }
    if (typeof release.tag_name !== 'string' || release.draft || release.prerelease)
      throw new Error('INVALID_RELEASE')
    // A public release can still be uploading. Require an installer for this platform.
    const extension =
      process.platform === 'darwin' ? '.dmg' : process.platform === 'win32' ? '.exe' : '.AppImage'
    if (
      !Array.isArray(release.assets) ||
      !release.assets.some((a) => a.state === 'uploaded' && a.name?.endsWith(extension))
    )
      throw new Error('RELEASE_NOT_READY')
    const currentVersion = app.getVersion()
    const result: AppUpdateResult = {
      currentVersion,
      latestVersion: release.tag_name.replace(/^v/, ''),
      available: isNewerRelease(release.tag_name, currentVersion),
      url: `${RELEASES}/tag/${encodeURIComponent(release.tag_name)}`,
      notes: typeof release.body === 'string' ? release.body.slice(0, 24_000) : ''
    }
    cached = { result, time: Date.now() }
    return result
  })().finally(() => {
    pending = undefined
  })
  return pending
}

export function registerAppUpdateIpc(): void {
  ipcMain.handle('app-update:check', () => checkAppUpdate())
  ipcMain.handle('app-update:open', () => shell.openExternal(cached?.result.url || RELEASES))
}
