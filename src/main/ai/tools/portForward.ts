import { z } from 'zod'
import { defineTool, ensureLink, intentSchema, type AnyTool } from './shared'
import {
  configureForward,
  controlForward,
  forwardInputSchema,
  portForwards
} from '../../portForward'

export const portForwardTools: AnyTool[] = [
  defineTool('list_port_forwards', {
    description:
      'List SSH port forwarding rules and live status. Includes owner and mine; only forwards owned by this conversation may be changed. Local listens on this computer and reaches targets FROM the SSH host; remote listens on the SSH host and reaches targets FROM this computer.',
    parameters: z.object({ hostId: z.string().optional(), description: intentSchema }),
    handler: async ({ hostId }, { sessionId }) =>
      portForwards
        .list()
        .filter((rule) => !hostId || rule.hostId === hostId)
        .map((rule) => ({ ...rule, mine: rule.owner === 'agent' && rule.sessionId === sessionId }))
  }),
  defineTool('configure_port_forward', {
    description:
      'Create or replace a temporary SSH TCP forwarding rule owned by this conversation. Does NOT start it. hostId must come from list_hosts. Default loopback listener. Local targetHost is resolved/reached by the SSH server; remote targetHost is resolved/reached by this computer. Stop a running rule before editing. User may adopt it in the port forwarding panel; otherwise it is removed when this conversation is deleted.',
    parameters: forwardInputSchema
      .omit({ startPolicy: true })
      .extend({ forwardId: z.string().optional(), description: intentSchema }),
    handler: async (input, { sessionId }) =>
      configureForward({ ...input, startPolicy: 'manual' }, input.forwardId, sessionId)
  }),
  defineTool('control_port_forward', {
    description:
      'Start, stop, restart or delete a forwarding rule owned by this conversation. Start establishes SSH and the listener without opening a user terminal. running means the listener was established, NOT that the target service is reachable. Stop closes active forwarded TCP connections. Resolve forwardId from list_port_forwards/configure_port_forward.',
    parameters: z.object({
      forwardId: z.string(),
      action: z.enum(['start', 'stop', 'restart', 'delete']),
      description: intentSchema
    }),
    handler: async ({ forwardId, action }, { sessionId }) => {
      const rule = portForwards.get(forwardId, sessionId)
      if (action === 'start' || action === 'restart') await ensureLink(rule.hostId)
      return controlForward(forwardId, action, sessionId)
    }
  }),
  defineTool('probe_port_forward', {
    description:
      'Test the target TCP connection of a forward owned by this conversation. Opens then closes a TCP connection; does not send application payload. Start local forwards before testing. Returns reachable, latencyMs and error; does not establish HTTP/database/application health.',
    parameters: z.object({ forwardId: z.string(), description: intentSchema }),
    handler: async ({ forwardId }, { sessionId }) => portForwards.probe(forwardId, sessionId)
  })
]
