import { z } from 'zod'
import { defineTool } from './shared'
import {
  createGroup,
  deleteGroup,
  listConnections,
  listGroups,
  setNote,
  updateGroup
} from '../../data/connections'
import { flattenGroups, groupChain } from '../../../shared/groupTree'
import type { ServerNote } from '../../../shared/types'
import { hostIdSchema, intentSchema, type AnyTool } from './shared'

/** edit_note 的入参：平铺结构的顶层字段级 patch（全字段可选 = 只传要改的字段；
 *  字段均为标量或一层行数组，机制上不存在嵌套部分覆盖丢字段；数组字段传完整新值整体替换） */
const noteSchema = z.object({
  purpose: z.string().optional().describe('One-line purpose of the host'),
  otherNics: z.array(z.string()).optional().describe('Other NIC IPs (full new list)'),
  internetAccess: z.boolean().optional().describe('Whether the host can reach the internet'),
  containerEnabled: z.boolean().optional().describe('Whether the host runs containers'),
  containers: z
    .array(z.object({ id: z.string().optional(), name: z.string().optional() }))
    .optional()
    .describe('Containers (full new list)'),
  images: z
    .array(z.object({ id: z.string().optional(), name: z.string().optional() }))
    .optional()
    .describe('Local images (full new list)'),
  cpuCores: z.number().optional().describe('CPU cores'),
  memory: z.string().optional().describe('Memory size (e.g. 8G)'),
  disk: z.string().optional().describe('Disk (e.g. 500G SSD)'),
  openPorts: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Port → service map (e.g. {"0.0.0.0:8080":"website"}; full new state incl. additions/removals)'
    ),
  services: z
    .array(z.object({ name: z.string().optional(), description: z.string().optional() }))
    .optional()
    .describe('Services running on the host (full new list)'),
  other: z.string().optional().describe('Anything else')
})

/** 主机资料域：分组管理与结构化备注（agent 的跨会话主机记忆） */
export const noteTools: AnyTool[] = [
  defineTool('list_groups', {
    description:
      'List all host groups (empty ones included) in tree display order, each with id, parentId and directory path (root first, same shape as list_hosts groupPath). Call this to resolve an existing group name to its groupId for add_connection / edit_connection / rename_group / delete_group.',
    parameters: z.object({ description: intentSchema }),
    handler: async () => {
      const groups = listGroups()
      return flattenGroups(groups).map(({ group }) => ({
        id: group.id,
        name: group.name,
        parentId: group.parentId,
        groupPath: groupChain(group.id, groups).map((g) => g.name)
      }))
    }
  }),

  defineTool('add_group', {
    description:
      'Create a host group (optional parentId to nest under an existing group). The returned groupId is used by add_connection / edit_connection.',
    parameters: z.object({
      description: intentSchema,
      name: z.string(),
      parentId: z.string().optional()
    }),
    handler: async ({ name, parentId }) => createGroup({ name, parentId: parentId ?? null })
  }),

  defineTool('rename_group', {
    description: 'Rename a group.',
    parameters: z.object({ description: intentSchema, groupId: z.string(), name: z.string() }),
    handler: async ({ groupId, name }) => {
      const next = updateGroup(groupId, { name })
      if (!next) throw new Error(`Group not found: ${groupId}`)
      return { id: next.id, name: next.name }
    }
  }),

  defineTool('delete_group', {
    description:
      'Delete a group and all its descendant groups; contained connections are kept and moved to ungrouped.',
    parameters: z.object({ description: intentSchema, groupId: z.string() }),
    handler: async ({ groupId }) => {
      const res = deleteGroup(groupId)
      if (!res) throw new Error(`Group not found: ${groupId}`)
      return { groupId, removedGroups: res.removed, ungroupedConnections: res.ungrouped }
    }
  }),

  defineTool('edit_note', {
    description:
      'Update selected fields of the host structured note (purpose/NICs/containers/performance/open ports/services etc.). The note is a SNAPSHOT of the current host state, not an operation log: describe only the present state, never record history — after an operation, update the fields to the new state (e.g. remove the nginx entry from services after uninstalling it); never write process records like "uninstalled/installed/modified/found". Pass only the top-level fields being changed; untouched fields keep their values. List/map fields (otherNics/containers/images/openPorts/services) take the COMPLETE new value as a whole. Read the current note via list_hosts (includeNote=true) first and edit from it; the updated note is readable via list_hosts for later tasks.',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema, note: noteSchema }),
    handler: async ({ hostId, note }) => {
      const conn = listConnections().find((c) => c.id === hostId)
      if (!conn) throw new Error(`Connection not found: ${hostId}`)
      // 顶层字段级合并：结构平铺（无嵌套对象容器），传谁改谁机制安全
      const next: ServerNote = { ...(conn.note ?? {}), ...note }
      setNote(hostId, next)
      return next
    }
  })
]
