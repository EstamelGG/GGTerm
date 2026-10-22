import { beforeEach, expect, it, vi } from 'vitest'
import { isNewerRelease } from '../src/shared/appUpdate'

type Handler = Parameters<typeof import('electron').ipcMain.handle>[1]
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  open: vi.fn(),
  handlers: new Map<string, Handler>()
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.11' },
  net: { fetch: mocks.fetch },
  shell: { openExternal: mocks.open },
  ipcMain: { handle: (name: string, fn: Handler) => mocks.handlers.set(name, fn) }
}))
beforeEach(() => {
  vi.resetModules()
  mocks.fetch.mockReset()
  mocks.open.mockReset()
})
const release = (overrides = {}): unknown => ({
  tag_name: 'v1.0.12',
  body: 'Changes',
  draft: false,
  prerelease: false,
  assets: ['.dmg', '.exe', '.AppImage'].map((ext) => ({ name: `ggterm${ext}`, state: 'uploaded' })),
  ...overrides
})
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status })

it('compares numeric versions, ignores metadata, handles current prereleases, and rejects invalid stable tags', () => {
  expect(isNewerRelease('v1.0.11', '1.0.9')).toBe(true)
  expect(isNewerRelease('v1.0.9', '1.0.11')).toBe(false)
  expect(isNewerRelease('v1.0.11+build.4', '1.0.11+build.2')).toBe(false)
  expect(isNewerRelease('1.0.11', '1.0.11-beta.1')).toBe(true)
  expect(isNewerRelease('1.0.11', '1.1.0')).toBe(false)
  expect(() => isNewerRelease('1.0.12-beta', '1.0.11')).toThrow()
  expect(() => isNewerRelease('v01.0.12', '1.0.11')).toThrow()
})

it('deduplicates checks, caches success and opens a fixed repository release URL', async () => {
  mocks.fetch.mockResolvedValue(response(release()))
  const { checkAppUpdate, registerAppUpdateIpc } = await import('../src/main/appUpdate')
  const first = checkAppUpdate()
  const second = checkAppUpdate()
  expect(first).toBe(second)
  expect(await first).toMatchObject({
    available: true,
    latestVersion: '1.0.12',
    currentVersion: '1.0.11'
  })
  await checkAppUpdate()
  expect(mocks.fetch).toHaveBeenCalledOnce()
  registerAppUpdateIpc()
  await mocks.handlers.get('app-update:open')!()
  expect(mocks.open).toHaveBeenCalledWith(
    'https://github.com/EstamelGG/GGTerm/releases/tag/v1.0.12'
  )
})

it('reports rate limits and retries failed requests', async () => {
  mocks.fetch.mockResolvedValueOnce(response({}, 403)).mockResolvedValueOnce(response(release()))
  const { checkAppUpdate } = await import('../src/main/appUpdate')
  await expect(checkAppUpdate()).rejects.toThrow('RATE_LIMITED')
  await expect(checkAppUpdate()).resolves.toMatchObject({ available: true })
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

it('rejects unfinished releases and prereleases', async () => {
  mocks.fetch
    .mockResolvedValueOnce(response(release({ assets: [] })))
    .mockResolvedValueOnce(response(release({ prerelease: true })))
    .mockResolvedValueOnce(response({}, 404))
  const { checkAppUpdate } = await import('../src/main/appUpdate')
  await expect(checkAppUpdate()).rejects.toThrow('RELEASE_NOT_READY')
  await expect(checkAppUpdate()).rejects.toThrow('INVALID_RELEASE')
  await expect(checkAppUpdate()).rejects.toThrow('NO_RELEASE')
})
