import Store from 'electron-store'
import { BrowserWindow } from 'electron'
import { z } from 'zod'
import type { PortForward, PortForwardAction, PortForwardInput } from '../shared/portForward'
import { PortForwardManager, type ForwardLink } from './ssh/portForwardManager'
import { listConnections } from './data/connections'
import { getOrCreateAgentLink, agentConnectionContext } from './ai/agentLinks'

const storage = new Store<{ rules: PortForward[] }>({
  name: 'port-forwards',
  defaults: { rules: [] }
})
let userLink: ((hostId: string) => Promise<ForwardLink>) | undefined
export function setForwardLinkResolver(resolver: typeof userLink): void {
  userLink = resolver
}

export const forwardInputSchema = z.object({
  name: z.string().max(200).default(''),
  hostId: z.string().min(1),
  type: z.enum(['local', 'remote']),
  listenAddress: z.string().default('127.0.0.1'),
  listenPort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1),
  targetPort: z.number().int().min(1).max(65535),
  startPolicy: z.enum(['manual', 'on-connect']).default('manual')
})

export const portForwards = new PortForwardManager(
  async (rule) => {
    const conn = listConnections().find((c) => c.id === rule.hostId)
    if (!conn) throw new Error('SSH host no longer exists')
    if (rule.owner === 'agent') {
      const link = rule.sessionId
        ? agentConnectionContext.run(rule.sessionId, () => getOrCreateAgentLink(conn))
        : undefined
      if (!link) throw new Error('Connect the SSH host before starting the forward')
      if (link.awaitingCredentials)
        throw new Error('This Agent connection requires manual credentials')
      link.start()
      return link
    }
    if (!userLink) throw new Error('Port forward service is not ready')
    return userLink(rule.hostId)
  },
  (rules) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send('port-forward:changed', rules)
  },
  (rules) => storage.set('rules', rules)
)
portForwards.load(storage.get('rules'))

export function configureForward(
  input: PortForwardInput,
  id?: string,
  sessionId?: string
): PortForward {
  const parsed = forwardInputSchema.parse(input)
  if (!listConnections().some((c) => c.id === parsed.hostId)) throw new Error('SSH host not found')
  return portForwards.configure(parsed, id, sessionId)
}

export async function controlForward(
  id: string,
  action: PortForwardAction,
  sessionId?: string
): Promise<PortForward | null> {
  portForwards.get(id, sessionId)
  switch (action) {
    case 'start':
      return portForwards.start(id, sessionId)
    case 'stop':
      return portForwards.stop(id, sessionId)
    case 'restart':
      await portForwards.stop(id, sessionId)
      return portForwards.start(id, sessionId)
    case 'delete':
      await portForwards.remove(id, sessionId)
      return null
    case 'adopt':
      if (sessionId) throw new Error('Only the user can adopt a temporary forward')
      await portForwards.stop(id)
      return portForwards.adopt(id)
    default:
      throw new Error('Unknown port forward action')
  }
}
