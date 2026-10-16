import { expect, it, vi } from 'vitest'
import type { HostConnection, SftpTransferEvent } from '../src/shared/types'
import type { HostLinkEvents } from '../src/main/ssh/link'

const mocks = vi.hoisted(() => ({ send: vi.fn(), getLink: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  }
}))
vi.mock('../src/main/ai/exec', () => ({ executions: {} }))
vi.mock('../src/main/ssh/link', () => ({
  getLink: mocks.getLink,
  removeLink: vi.fn(),
  HostLink: class {
    sftp = { hasTransfer: vi.fn(() => false), cancelTransfer: vi.fn(), retryCleanup: vi.fn() }
    constructor(
      public hostId: string,
      _conn: unknown,
      public events: HostLinkEvents
    ) {}
  }
}))

it('broadcasts agent transfers and resolves controls to the owning AI session', async () => {
  const { agentConnectionContext, getOrCreateAgentLink, findTransferSession } =
    await import('../src/main/ai/agentLinks')
  const conn = { id: 'host' } as HostConnection
  const first = agentConnectionContext.run('first', () => getOrCreateAgentLink(conn))
  const second = agentConnectionContext.run('second', () => getOrCreateAgentLink(conn))
  vi.mocked(second.sftp.hasTransfer).mockImplementation((id) => id === 'download')
  const event = {
    hostId: 'host',
    transfer: { id: 'download', status: 'running' }
  } as SftpTransferEvent
  ;(second as unknown as { events: HostLinkEvents }).events.onSftpTransfer(event)
  expect(mocks.send).toHaveBeenCalledWith('sftp:transfer', event)
  findTransferSession('host', 'download')?.cancelTransfer('download')
  expect(second.sftp.cancelTransfer).toHaveBeenCalledWith('download')
  expect(first.sftp.cancelTransfer).not.toHaveBeenCalled()
  expect(findTransferSession('other-host', 'download')).toBeUndefined()
  expect(findTransferSession('host', 'missing')).toBeUndefined()
  mocks.getLink.mockReturnValue({ sftp: first.sftp })
  vi.mocked(first.sftp.hasTransfer).mockImplementation((id) => id === 'manual')
  expect(findTransferSession('host', 'manual')).toBe(first.sftp)
})
