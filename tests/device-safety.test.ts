import { beforeEach, expect, it, vi } from 'vitest'
import { deviceGuidance, isNetworkDevice } from '../src/shared/device'
const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(() => [{ id: 'switch', deviceType: 'huawei' }]),
  start: vi.fn(),
  wait: vi.fn(),
  exec: vi.fn(),
  getLink: vi.fn(),
  monitor: vi.fn(),
  gpu: vi.fn()
}))
vi.mock('../src/main/data/connections', () => ({ listConnections: mocks.listConnections }))
vi.mock('../src/main/ai/exec', () => ({ executions: { start: mocks.start, wait: mocks.wait } }))
vi.mock('../src/main/ai/agentLinks', () => ({ getOrCreateAgentLink: mocks.getLink }))
vi.mock('../src/main/ssh/link', () => ({ getLink: mocks.getLink }))
vi.mock('../src/main/ssh/perf', () => ({ PerfMonitor: mocks.monitor, SESSION_INTERVAL_MS: 3000 }))
vi.mock('../src/main/ssh/gpuPerf', () => ({ sessionGpuWatch: mocks.gpu }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
const { executeTool } = await import('../src/main/ai/tools/execute')
const { sftpOf } = await import('../src/main/ai/tools/shared')
const { sessionPerfWatch } = await import('../src/main/ssh/sessionPerf')
beforeEach(() => vi.clearAllMocks())
it('distinguishes switches from Linux and never assumes Linux for unspecified hosts', () => {
  expect(isNetworkDevice({ deviceType: 'zte' })).toBe(true)
  expect(isNetworkDevice({ deviceType: 'ubuntu' })).toBe(false)
  expect(deviceGuidance({})).toContain('Do not assume Linux')
  expect(deviceGuidance({ deviceType: 'huawei' })).toContain('NOT a Linux shell')
})
it('rejects a first command before opening a network shell', async () => {
  await expect(
    executeTool.handler(
      { action: 'start', hostId: 'switch', command: 'uname -a' },
      { sessionId: 's', toolCallId: 't', toolName: 'execute' }
    )
  ).rejects.toThrow('start without command')
  expect(mocks.start).not.toHaveBeenCalled()
})
it('allows a plain shell to inspect the login banner', async () => {
  mocks.start.mockReturnValue('execution')
  await executeTool.handler(
    { action: 'start', hostId: 'switch' },
    { sessionId: 's', toolCallId: 't', toolName: 'execute' }
  )
  expect(mocks.start).toHaveBeenCalledWith('s', { target: 'remote', hostId: 'switch', command: '' })
})
it('does not create a performance or GPU probe for a switch', () => {
  sessionPerfWatch('switch')
  expect(mocks.getLink).not.toHaveBeenCalled()
  expect(mocks.monitor).not.toHaveBeenCalled()
  expect(mocks.gpu).toHaveBeenCalledWith(null)
})
it('rejects automatic SFTP access before creating a transport', async () => {
  await expect(sftpOf('switch')).rejects.toThrow('SFTP is disabled')
  expect(mocks.getLink).not.toHaveBeenCalled()
})
