export interface PortForwardInput {
  name: string
  hostId: string
  type: 'local' | 'remote'
  listenAddress: string
  listenPort: number
  targetHost: string
  targetPort: number
  startPolicy: 'manual' | 'on-connect'
}

export type PortForwardStatus =
  'stopped' | 'connecting' | 'starting' | 'running' | 'reconnecting' | 'error'

export interface PortForward extends PortForwardInput {
  id: string
  owner: 'user' | 'agent'
  sessionId?: string
  status: PortForwardStatus
  connections: number
  bytesUp: number
  bytesDown: number
  error: string | null
}

export type PortForwardAction = 'start' | 'stop' | 'restart' | 'delete' | 'adopt'

export function endpoint(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}
