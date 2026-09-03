import { beforeEach, expect, it, vi } from 'vitest'

/**
 * list_connections：列出「此刻存在的 SSH 传输」，不是保存的连接 ——
 * user = 应用窗口链路（每主机最多一条），agent = 各 AI 会话独占链路（含其他会话，故同一主机可多条）；
 * 跳板链取链路快照的事实值（实际建立 / 正在拨的链），并标出哪些属于本对话。
 * 口径：只列有传输的相位（connecting / reconnecting / connected）；idle / offline 不入列。
 */

const connections = vi.hoisted(() => ({
  listConnections: vi.fn(() => [] as unknown[]),
  listGroups: vi.fn(() => [] as unknown[])
}))
vi.mock('../src/main/data/connections', () => connections)

const links = vi.hoisted(() => ({
  getLink: vi.fn(),
  listLinks: vi.fn(() => [] as unknown[])
}))
vi.mock('../src/main/ssh/link', () => links)

const agentLinks = vi.hoisted(() => ({
  getAgentLink: vi.fn(),
  getOrCreateAgentLink: vi.fn(),
  listAgentConnections: vi.fn(() => [] as unknown[]),
  disconnectAgentLink: vi.fn()
}))
vi.mock('../src/main/ai/agentLinks', () => agentLinks)

const { connectionTools } = await import('../src/main/ai/tools/connection')
const listConnectionsTool = connectionTools.find((tool) => tool.name === 'list_connections')!
const invocation = { sessionId: 'me', toolCallId: 'call', toolName: 'list_connections' }

interface Row {
  connectionId: string
  owner: string
  mine: boolean
  name: string
  address: string
  phase: string
  attempt: number | null
  shells: number
  jumpChain: { hostId: string; name: string }[]
}

const run = async (): Promise<Row[]> => (await listConnectionsTool.handler({}, invocation)) as Row[]

const host = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  host: `${id}.test`,
  port: 22,
  username: 'root',
  groupId: null,
  jumpHostIds: []
})

/** 链路快照（listLinks / listAgentConnections 的公共形状） */
const snap = (
  hostId: string,
  phase: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({ hostId, phase, since: 1, jumpIds: [], ...extra })

/** 用户侧 HostLink：本工具只用到 connectionId 与 shells.size */
const userLink = (connectionId: string, shells: number): Record<string, unknown> => ({
  connectionId,
  shells: new Map(Array.from({ length: shells }, (_, i) => [`s${i}`, {}]))
})

beforeEach(() => {
  vi.clearAllMocks()
  connections.listConnections.mockReturnValue([])
  links.listLinks.mockReturnValue([])
  links.getLink.mockReturnValue(undefined)
  agentLinks.listAgentConnections.mockReturnValue([])
})

it('splits transports by owner and carries the jump chain actually in use', async () => {
  connections.listConnections.mockReturnValue([
    host('h1', 'web-1'),
    host('h2', 'db-1'),
    host('j1', 'jump-1')
  ])
  // 用户侧：h1 经 j1 已建立（挂 2 个终端）；h2 已断开（idle，无传输）
  links.listLinks.mockReturnValue([
    snap('h1', 'connected', { jumpIds: ['j1'] }),
    snap('h2', 'idle')
  ])
  links.getLink.mockImplementation((hostId: string) =>
    hostId === 'h1' ? userLink('u1', 2) : undefined
  )
  agentLinks.listAgentConnections.mockReturnValue([
    { ...snap('h1', 'connected'), connectionId: 'a1', sessionId: 'me', shellCount: 2 },
    {
      ...snap('h2', 'reconnecting', { jumpIds: ['j1'], attempt: 3 }),
      connectionId: 'a2',
      sessionId: 'other',
      shellCount: 0
    },
    { ...snap('h2', 'offline'), connectionId: 'a3', sessionId: 'me', shellCount: 0 }
  ])

  const rows = await run()
  // 按主机名归组、组内 owner 定序；idle / offline 不入列（同一主机因此可能两条）
  expect(rows.map((r) => [r.owner, r.connectionId, r.mine, r.name, r.phase, r.shells])).toEqual([
    ['agent', 'a2', false, 'db-1', 'reconnecting', 0],
    ['agent', 'a1', true, 'web-1', 'connected', 2],
    ['user', 'u1', false, 'web-1', 'connected', 2]
  ])
  const byId = new Map(rows.map((r) => [r.connectionId, r]))
  // 跳板链 = 实际使用的链（含拨号中那条），名称解析自保存的连接
  expect(byId.get('u1')!.jumpChain).toEqual([{ hostId: 'j1', name: 'jump-1' }])
  expect(byId.get('a2')!.jumpChain).toEqual([{ hostId: 'j1', name: 'jump-1' }])
  expect(byId.get('a1')!.jumpChain).toEqual([])
  expect(byId.get('u1')!.address).toBe('root@h1.test:22')
  expect(byId.get('a2')!.attempt).toBe(3)
})

it('falls back to the id prefix when a jump host is no longer saved', async () => {
  links.listLinks.mockReturnValue([snap('h1', 'connecting', { jumpIds: ['gone-host-id'] })])

  const rows = await run()
  expect(rows[0].jumpChain).toEqual([{ hostId: 'gone-host-id', name: 'gone-hos' }])
  // 目标也已被删除：地址退化留空，但传输本身仍要如实列出
  expect(rows[0].address).toBe('')
  expect(rows[0].phase).toBe('connecting')
})
