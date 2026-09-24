import { DEVICE_TYPES } from '../../shared/device'
import Store from 'electron-store'
import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import type { HostConnection, HostGroup, ServerNote } from '../../shared/types'
import { descendantsOf } from '../../shared/groupTree'

interface ConnectionStoreData {
  connections: HostConnection[]
  groups: HostGroup[]
}

const store = new Store<ConnectionStoreData>({
  name: 'connections',
  defaults: { connections: [], groups: [] }
})

/** 任意来源（IPC 表单/agent tool/导入）的增删改后广播全量快照，渲染层据此刷新目录树 */
function emitChanged(): void {
  const payload = { connections: listConnections(), groups: listGroups() }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('connections:changed', payload)
  }
}

export function listConnections(): HostConnection[] {
  return store.get('connections')
}

export function listGroups(): HostGroup[] {
  return store.get('groups')
}

/** 创建连接；返回完整记录（生成 id/时间戳/默认值） */
export function createConnection(
  input: Partial<HostConnection> & Pick<HostConnection, 'name' | 'host' | 'username'>
): HostConnection {
  const now = Date.now()
  const conn: HostConnection = {
    id: input.id ?? randomUUID(),
    name: input.name,
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    deviceType:
      input.deviceType && Object.hasOwn(DEVICE_TYPES, input.deviceType)
        ? input.deviceType
        : undefined,
    authType: input.authType ?? 'password',
    groupId: input.groupId ?? null,
    connectTimeout: input.connectTimeout ?? 20000,
    strictKex: input.strictKex ?? false,
    keepaliveInterval: input.keepaliveInterval ?? 5000,
    initCommand: input.initCommand ?? '',
    initDir: input.initDir ?? '',
    perfDisabled: input.perfDisabled ?? false,
    jumpHostIds: input.jumpHostIds ?? [],
    createdAt: input.createdAt ?? now,
    updatedAt: now
  }
  store.set('connections', [...listConnections(), conn])
  emitChanged()
  return conn
}

export function updateConnection(
  id: string,
  patch: Partial<HostConnection>
): HostConnection | null {
  const list = listConnections()
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return null
  if (patch.deviceType && !Object.hasOwn(DEVICE_TYPES, patch.deviceType))
    throw new Error('Unknown host type')
  const next: HostConnection = { ...list[idx], ...patch, id, updatedAt: Date.now() }
  list[idx] = next
  store.set('connections', list)
  emitChanged()
  return next
}

/** 仅替换结构化备注；性能失效由 IPC 调用点决定，此处复用持久化与广播。 */
export function setNote(id: string, note: ServerNote): HostConnection | null {
  return updateConnection(id, { note })
}

export function deleteConnection(id: string): boolean {
  const list = listConnections()
  const next = list.filter((c) => c.id !== id)
  if (next.length === list.length) return false
  // 级联清理：其它连接跳板链中对该主机的引用（防悬空 id 到下次连接才报错）
  store.set(
    'connections',
    next.map((c) =>
      c.jumpHostIds?.length ? { ...c, jumpHostIds: c.jumpHostIds.filter((j) => j !== id) } : c
    )
  )
  emitChanged()
  return true
}

export function createGroup(
  input: Partial<HostGroup> & Pick<HostGroup, 'name'>,
  siblings: HostGroup[] = listGroups()
): HostGroup {
  const maxSort = siblings
    .filter((g) => g.parentId === (input.parentId ?? null))
    .reduce((m, g) => Math.max(m, g.sort), 0)
  const group: HostGroup = {
    id: input.id ?? randomUUID(),
    name: input.name,
    parentId: input.parentId ?? null,
    colorHex: input.colorHex ?? '#FF7700',
    sort: input.sort ?? maxSort + 1
  }
  store.set('groups', [...listGroups(), group])
  emitChanged()
  return group
}

export function updateGroup(id: string, patch: Partial<HostGroup>): HostGroup | null {
  const list = listGroups()
  const idx = list.findIndex((g) => g.id === id)
  if (idx < 0) return null
  const next: HostGroup = { ...list[idx], ...patch, id }
  list[idx] = next
  store.set('groups', list)
  emitChanged()
  return next
}

/** 删除分组及所有后代；其中的连接不被删除而是归入未分组（对照 Swift removeGroup 级联） */
export function deleteGroup(id: string): { removed: string[]; ungrouped: number } | null {
  const groups = listGroups()
  const target = groups.find((g) => g.id === id)
  if (!target) return null

  const removed = new Set<string>([id, ...descendantsOf(id, groups)])

  store.set(
    'groups',
    groups.filter((g) => !removed.has(g.id))
  )

  const conns = listConnections()
  let ungrouped = 0
  const nextConns = conns.map((c) => {
    if (c.groupId && removed.has(c.groupId)) {
      ungrouped += 1
      return { ...c, groupId: null, updatedAt: Date.now() }
    }
    return c
  })
  store.set('connections', nextConns)
  emitChanged()
  return { removed: [...removed], ungrouped }
}
