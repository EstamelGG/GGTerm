import { beforeEach, expect, it, vi } from 'vitest'

/**
 * list_hosts 连接计数：主机当前建立的 SSH 传输按归属拆分 ——
 * user = 应用界面链路（每主机最多一条），agent = 各 AI 会话独占链路（本会话之外的会话也计入）。
 * 口径：只有 phase === 'connected' 计入 total；connecting/reconnecting 只计入 pending。
 */

const connections = vi.hoisted(() => ({
  listConnections: vi.fn(() => [] as unknown[]),
  listGroups: vi.fn(() => [] as unknown[])
}))
vi.mock('../src/main/data/connections', () => connections)

const links = vi.hoisted(() => ({ getLink: vi.fn() }))
vi.mock('../src/main/ssh/link', () => links)

const agentLinks = vi.hoisted(() => ({
  getAgentLink: vi.fn(),
  getOrCreateAgentLink: vi.fn(),
  listAgentConnections: vi.fn(() => [] as unknown[]),
  disconnectAgentLink: vi.fn()
}))
vi.mock('../src/main/ai/agentLinks', () => agentLinks)

const { connectionTools } = await import('../src/main/ai/tools/connection')
const listHosts = connectionTools.find((tool) => tool.name === 'list_hosts')!
const invocation = { sessionId: 'owner', toolCallId: 'call', toolName: 'list_hosts' }

interface HostRow {
  name: string
  phase: string
  duplicate: boolean
  connections: { total: number; user: number; agent: number; pending: number }
}

const run = async (args: Record<string, unknown> = {}): Promise<HostRow[]> =>
  (await listHosts.handler(args, invocation)) as HostRow[]

const host = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  groupId: null,
  jumpHostIds: []
})

const link = (
  connectionId: string,
  hostId: string,
  phase: string
): { connectionId: string; hostId: string; phase: string; since: number } => ({
  connectionId,
  hostId,
  phase,
  since: 0
})

beforeEach(() => {
  vi.clearAllMocks()
  connections.listConnections.mockReturnValue([])
  connections.listGroups.mockReturnValue([])
  agentLinks.listAgentConnections.mockReturnValue([])
  agentLinks.getAgentLink.mockReturnValue(undefined)
  links.getLink.mockReturnValue(undefined)
})

it('counts established transports split by owner (other AI conversations included)', async () => {
  connections.listConnections.mockReturnValue([host('h1', 'web-1'), host('h2', 'db-1')])
  links.getLink.mockImplementation((hostId: string) =>
    hostId === 'h1' ? { phase: 'connected' } : undefined
  )
  agentLinks.getAgentLink.mockReturnValue({ isActive: true, phase: 'connected' })
  agentLinks.listAgentConnections.mockReturnValue([
    link('a1', 'h1', 'connected'),
    link('a2', 'h1', 'connected'),
    link('a3', 'h2', 'offline')
  ])

  const [web, db] = await run()
  expect(web.connections).toEqual({ total: 3, user: 1, agent: 2, pending: 0 })
  expect(db.connections).toEqual({ total: 0, user: 0, agent: 0, pending: 0 })
})

it('reports dialing/reconnecting links as pending, never as established', async () => {
  connections.listConnections.mockReturnValue([host('h1', 'web-1')])
  links.getLink.mockReturnValue({ phase: 'reconnecting' })
  agentLinks.getAgentLink.mockReturnValue({ isActive: false, phase: 'connecting' })
  agentLinks.listAgentConnections.mockReturnValue([link('a1', 'h1', 'connecting')])

  const [web] = await run()
  expect(web.connections).toEqual({ total: 0, user: 0, agent: 0, pending: 2 })
  // 本会话链路相位仍单独上报（与连接数口径互不覆盖）
  expect(web.phase).toBe('connecting')
})

it('keeps the rest of the host payload (note opt-in) intact', async () => {
  connections.listConnections.mockReturnValue([
    { ...host('h1', 'web-1'), note: { text: 'nginx' }, jumpHostIds: ['j1'] }
  ])

  const [plain] = await run()
  expect(plain.duplicate).toBe(false)
  expect(plain).not.toHaveProperty('note')

  const [withNote] = await run({ includeNote: true })
  expect(withNote).toHaveProperty('note')
})
