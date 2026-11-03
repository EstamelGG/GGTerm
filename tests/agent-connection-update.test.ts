import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  save: vi.fn(),
  invalidate: vi.fn(),
  conn: { id: 'host', name: 'Host', host: 'example.test', port: 22, username: 'user' }
}))
vi.mock('../src/main/data/connections', () => ({
  createConnection: vi.fn(),
  deleteConnection: vi.fn(),
  listConnections: () => [mocks.conn],
  updateConnection: mocks.update
}))
vi.mock('../src/main/data/secrets', () => ({
  deleteSecrets: vi.fn(),
  loadSecrets: vi.fn(),
  saveSecrets: mocks.save
}))
vi.mock('../src/main/ssh/perfHub', () => ({ perfInvalidate: mocks.invalidate }))
vi.mock('../src/main/sshTest', () => ({ sshTest: vi.fn() }))
vi.mock('../src/main/ssh/link', () => ({ removeLink: vi.fn() }))
vi.mock('../src/main/portForward', () => ({ portForwards: {} }))
vi.mock('../src/main/ai/agentLinks', () => ({
  listAgentConnections: vi.fn(),
  closeAgentConnection: vi.fn()
}))
vi.mock('../src/main/probe', () => ({ probeDetail: vi.fn() }))
vi.mock('../src/main/ai/tools/shared', async () => {
  const { z } = await import('zod')
  return {
    defineTool: (name: string, definition: object) => ({ name, ...definition }),
    hostIdSchema: z.string(),
    intentSchema: z.string().optional()
  }
})
const { manageTools } = await import('../src/main/ai/tools/manage')
const edit = manageTools.find((tool) => tool.name === 'edit_connection')!
const invocation = { sessionId: 'session', toolCallId: 'call' }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.update.mockImplementation((_id, patch) => ({ ...mocks.conn, ...patch }))
})

it.each([
  { host: 'new.test' },
  { password: 'new-password' },
  { host: 'new.test', password: 'new-password' }
])('invalidates monitoring after saving %j', async (patch) => {
  await edit.handler({ hostId: 'host', description: 'Update host', ...patch }, invocation)
  expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('host')
  if ('password' in patch)
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0]
    )
  if ('host' in patch) expect(mocks.update).toHaveBeenCalledWith('host', { host: 'new.test' })
  else expect(mocks.update).not.toHaveBeenCalled()
})

it('does not treat a display description as a connection change', async () => {
  await expect(
    edit.handler({ hostId: 'host', description: 'No changes' }, invocation)
  ).rejects.toThrow('No fields to update')
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.invalidate).not.toHaveBeenCalled()
})
