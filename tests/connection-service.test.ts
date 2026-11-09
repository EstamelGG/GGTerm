import { beforeEach, expect, it, vi } from 'vitest'
import type { ConnectionSecrets, HostConnection, ServerNote } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  records: [] as HostConnection[],
  credentials: {} as Record<string, ConnectionSecrets>,
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  save: vi.fn(),
  invalidate: vi.fn(),
  forget: vi.fn(),
  detach: vi.fn(),
  closeUser: vi.fn(),
  closeAgent: vi.fn(),
  stopSftp: vi.fn()
}))
vi.mock('../src/main/data/connections', () => ({
  listConnections: () => mocks.records,
  createConnection: mocks.create,
  updateConnection: mocks.update,
  deleteConnection: mocks.remove,
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  setNote: vi.fn()
}))
vi.mock('../src/main/data/secrets', () => ({
  loadSecrets: (id: string) => ({
    password: '',
    privateKey: '',
    passphrase: '',
    ...mocks.credentials[id]
  }),
  saveSecrets: mocks.save
}))
vi.mock('../src/main/ssh/perfHub', () => ({
  perfInvalidate: mocks.invalidate,
  perfForget: mocks.forget
}))
vi.mock('../src/main/ssh/link', () => ({ removeLink: mocks.closeUser }))
vi.mock('../src/main/ssh/resourceLink', () => ({ stopResourceSftp: mocks.stopSftp }))
vi.mock('../src/main/ai/agentLinks', () => ({
  listAgentConnections: () => [
    { hostId: 'host', connectionId: 'a' },
    { hostId: 'host', connectionId: 'b' },
    { hostId: 'other', connectionId: 'c' }
  ],
  closeAgentConnection: mocks.closeAgent
}))
vi.mock('../src/main/portForward', () => ({ portForwards: { detachHost: mocks.detach } }))
const service = await import('../src/main/connections')
const { connectionRegistry } = await import('../src/main/ssh/connectionRegistry')
const host = { id: 'host', name: 'Host', host: 'example.test', username: 'user' } as HostConnection
beforeEach(() => {
  vi.resetAllMocks()
  mocks.records = [{ ...host }]
  mocks.credentials = { host: { password: 'old', privateKey: '', passphrase: '' } }
  mocks.save.mockImplementation((id, patch) => {
    mocks.credentials[id] = { ...mocks.credentials[id], ...patch }
  })
  mocks.create.mockImplementation((input) => {
    mocks.records.push(input)
    return input
  })
  mocks.update.mockImplementation((id, patch) => {
    const next = { ...mocks.records.find((item) => item.id === id), ...patch }
    mocks.records = mocks.records.map((item) => (item.id === id ? next : item))
    return next
  })
  mocks.remove.mockImplementation((id) => {
    mocks.records = mocks.records.filter((item) => item.id !== id)
    return true
  })
})

it('saves credentials before publishing the connection and refreshes monitoring once', () => {
  mocks.update.mockImplementationOnce((_id, patch) => {
    expect(mocks.credentials.host.password).toBe('new')
    return { ...host, ...patch }
  })
  expect(service.updateConnection('host', { name: 'Updated' }, { password: 'new' })).toMatchObject({
    name: 'Updated'
  })
  expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('host')
})
it('restores old credentials when a record update fails', () => {
  mocks.update.mockImplementationOnce(() => {
    throw new Error('disk full')
  })
  expect(() => service.updateConnection('host', { name: 'Updated' }, { password: 'new' })).toThrow(
    'disk full'
  )
  expect(mocks.credentials.host.password).toBe('old')
  expect(mocks.records[0].name).toBe('Host')
  expect(mocks.invalidate).not.toHaveBeenCalled()
})
it('does not publish metadata if saving credentials fails', () => {
  mocks.save.mockImplementationOnce(() => {
    throw new Error('credential storage failed')
  })
  expect(() => service.updateConnection('host', { name: 'Updated' }, { password: 'new' })).toThrow(
    'credential storage failed'
  )
  expect(mocks.update).not.toHaveBeenCalled()
})
it('reports both failures if restoring credentials also fails', () => {
  const writeError = new Error('record storage failed')
  const rollbackError = new Error('credential rollback failed')
  mocks.update.mockImplementationOnce(() => {
    throw writeError
  })
  mocks.save
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw rollbackError
    })
  let failure: unknown
  try {
    service.updateConnection('host', { name: 'Updated' }, { password: 'new' })
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([writeError, rollbackError])
  expect(mocks.invalidate).not.toHaveBeenCalled()
})
it('compensates a failed create without leaving the new secret', () => {
  mocks.create.mockImplementationOnce(() => {
    throw new Error('record storage failed')
  })
  expect(() => service.createConnection({ ...host, id: 'new' }, { password: 'secret' })).toThrow(
    'record storage failed'
  )
  expect(mocks.credentials.new.password).toBe('')
  expect(mocks.records).toEqual([host])
})
it('does not overwrite an existing id or save secrets for a missing record', () => {
  expect(() => service.createConnection(host, { password: 'new' })).toThrow('already exists')
  expect(service.updateConnection('missing', {}, { password: 'new' })).toBeNull()
  expect(mocks.save).not.toHaveBeenCalled()
})
it('deletes all transports for the target host and leaves other hosts alone', async () => {
  expect(await service.deleteConnection('host')).toBe(true)
  expect(mocks.detach).toHaveBeenCalledWith('host')
  expect(mocks.closeUser).toHaveBeenCalledWith('host')
  expect(mocks.stopSftp).toHaveBeenCalledWith('host')
  expect(mocks.closeAgent.mock.calls).toEqual([
    ['host', 'a'],
    ['host', 'b']
  ])
  expect(mocks.credentials.host.password).toBe('')
  expect(mocks.records).toEqual([])
  expect(mocks.forget).toHaveBeenCalledWith('host')
})
it('keeps metadata and credentials on cleanup failure and allows a retry', async () => {
  mocks.detach.mockRejectedValueOnce(new Error('forward cleanup failed'))
  await expect(service.deleteConnection('host')).rejects.toThrow('forward cleanup failed')
  expect(mocks.records).toEqual([host])
  expect(mocks.credentials.host.password).toBe('old')
  expect(await service.deleteConnection('host')).toBe(true)
})
it('restores credentials when deleting the persisted record fails', async () => {
  mocks.remove.mockImplementationOnce(() => {
    throw new Error('record deletion failed')
  })
  await expect(service.deleteConnection('host')).rejects.toThrow('record deletion failed')
  expect(mocks.records).toEqual([host])
  expect(mocks.credentials.host.password).toBe('old')
  expect(mocks.forget).not.toHaveBeenCalled()
  expect(await service.deleteConnection('host')).toBe(true)
})
it('rejects competing edits while asynchronous deletion is in progress', async () => {
  let release!: () => void
  mocks.detach.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve
    })
  )
  const deletion = service.deleteConnection('host')
  expect(() => connectionRegistry.assertAvailable('host')).toThrow('deletion is in progress')
  expect(() => service.updateConnection('host', { name: 'race' })).toThrow(
    'deletion is in progress'
  )
  expect(() => service.setNote('host', {} as ServerNote)).toThrow('deletion is in progress')
  await expect(service.deleteConnection('host')).rejects.toThrow('deletion is in progress')
  release()
  await deletion
  expect(() => connectionRegistry.assertAvailable('host')).not.toThrow()
})
