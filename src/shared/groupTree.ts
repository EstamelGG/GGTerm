import type { HostGroup } from './types'

/** 对照 ATerminal-Swift Models/HostGroup.swift GroupTree：纯函数树工具 */

const sortGroups = (a: HostGroup, b: HostGroup): number =>
  a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hans')

/** 某父节点的直接子级（排序后） */
export function childrenOf(parentId: string | null, groups: HostGroup[]): HostGroup[] {
  return groups.filter((g) => g.parentId === parentId).sort(sortGroups)
}

/** 一次建立父子索引，避免每访问一个节点都扫描全量分组。 */
function indexChildren(groups: HostGroup[]): Map<string | null, HostGroup[]> {
  const children = new Map<string | null, HostGroup[]>()
  for (const group of groups) {
    const siblings = children.get(group.parentId)
    if (siblings) siblings.push(group)
    else children.set(group.parentId, [group])
  }
  return children
}

/** 收集所有后代 id（不含自身；环形数据按已访问节点截断）。 */
export function descendantsOf(id: string, groups: HostGroup[]): Set<string> {
  const children = indexChildren(groups)
  const out = new Set([id])
  const pending = [id]
  while (pending.length) {
    for (const group of children.get(pending.pop()!) ?? []) {
      if (out.has(group.id)) continue
      out.add(group.id)
      pending.push(group.id)
    }
  }
  out.delete(id)
  return out
}

/** 从根到 id 的目录链（含自身；数据异常成环时按已走链截断） */
export function groupChain(id: string, groups: HostGroup[]): HostGroup[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const chain: HostGroup[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    chain.push(cur)
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return chain.reverse()
}

/** 整棵树 DFS 拍平为 (group, depth) 行；迭代遍历避免深层分组耗尽调用栈。 */
export function flattenGroups(groups: HostGroup[]): { group: HostGroup; depth: number }[] {
  const children = indexChildren(groups)
  for (const siblings of children.values()) siblings.sort(sortGroups)
  const out: { group: HostGroup; depth: number }[] = []
  const pending = (children.get(null) ?? []).map((group) => ({ group, depth: 0 })).reverse()
  const seen = new Set<string>()
  while (pending.length) {
    const row = pending.pop()!
    if (seen.has(row.group.id)) continue
    seen.add(row.group.id)
    out.push(row)
    const descendants = children.get(row.group.id) ?? []
    for (let i = descendants.length - 1; i >= 0; i--) {
      pending.push({ group: descendants[i], depth: row.depth + 1 })
    }
  }
  return out
}
