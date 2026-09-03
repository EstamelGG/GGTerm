import { StringDecoder } from 'node:string_decoder'
import type { Client } from 'ssh2'
import type { ExecutionConnector, ExecutionEvents, ExecutionTransport } from './executionManager'
import { ExecutionManager } from './executionManager'

/** Background interactive remote shell; only the Agent writes input, the viewer is read-only. */
export function connectRemoteExecution(
  client: Client,
  command: string,
  events: ExecutionEvents
): Promise<ExecutionTransport> {
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: 120, rows: 30 }, (error, channel) => {
      if (error || !channel) {
        reject(error ?? new Error('SSH shell failed'))
        return
      }
      const stdout = new StringDecoder('utf8')
      const stderr = new StringDecoder('utf8')
      let exitReceived = false
      let exitCode: number | null = null
      let exitSignal: string | undefined
      let closed = false
      const cleanup = (): void => {
        client.removeListener('close', lost)
        client.removeListener('end', lost)
      }
      const lost = (): void => {
        if (closed) return
        closed = true
        cleanup()
        events.data(stdout.end() + stderr.end())
        events.lost(
          'SSH channel lost; cannot confirm whether the remote process ended — do NOT rerun the command automatically'
        )
      }
      client.once('close', lost)
      client.once('end', lost)
      channel.on('data', (data: Buffer) => {
        if (!closed) events.data(stdout.write(data))
      })
      channel.stderr.on('data', (data: Buffer) => {
        if (!closed) events.data(stderr.write(data))
      })
      channel.on('exit', (code: number | null, signal?: string) => {
        exitReceived = true
        exitCode = typeof code === 'number' ? code : null
        exitSignal = signal
      })
      channel.on('error', lost)
      channel.on('close', () => {
        if (closed) return
        if (!exitReceived) {
          lost()
          return
        }
        closed = true
        cleanup()
        events.data(stdout.end() + stderr.end())
        events.exit(exitCode, exitSignal)
      })
      if (command) channel.write(command.endsWith('\n') ? command : `${command}\n`)
      resolve({
        write: (data) => {
          if (closed || !channel.writable)
            throw new Error('Execution channel not writable; input was not sent')
          channel.write(data)
        },
        interrupt: () => {
          if (closed || !channel.writable)
            throw new Error('Execution channel not writable; cannot interrupt')
          channel.write('\x03')
        },
        close: () => {
          if (!closed) channel.close()
        }
      })
    })
  })
}

// The connection resolver is registered by tools.ts, keeping this transport module independent of link.ts.
let remoteClient: ((hostId: string) => Promise<Client>) | undefined
export function setExecutionClientResolver(resolve: (hostId: string) => Promise<Client>): void {
  remoteClient = resolve
}
const connect: ExecutionConnector = async (input, events, signal) => {
  if (!remoteClient || !input.hostId)
    throw new Error('Remote execution missing connection resolver or hostId')
  const client = await remoteClient(input.hostId)
  signal?.throwIfAborted()
  return connectRemoteExecution(client, input.command, events)
}
export const executions = new ExecutionManager(connect)
