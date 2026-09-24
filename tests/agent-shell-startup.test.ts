import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { HostConnection } from '../src/shared/types'

const probes = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/data/secrets', () => ({ loadSecrets: () => ({ password: 'fixture' }) }))
vi.mock('../src/main/data/connections', () => ({ listConnections: () => [] }))
vi.mock('../src/main/ssh/hostKeys', () => ({
  createHostVerifier: () => ({ verify: () => true, error: () => null })
}))
vi.mock('../src/main/i18n', () => ({ t: (key: string) => key }))
vi.mock('../src/main/ssh/sftp', () => ({
  SftpSession: class {
    stop = vi.fn()
    hostLinkRestored = vi.fn()
    hostLinkLost = vi.fn()
  },
  execCommand: probes.exec
}))
vi.mock('ssh2', () => ({
  Client: class extends EventEmitter {
    connect(): void {
      queueMicrotask(() => this.emit('ready'))
    }
    setNoDelay = vi.fn()
    end = vi.fn()
    shell(_options: unknown, callback: (err: Error | null, channel?: PassThrough) => void): void {
      const channel = Object.assign(new PassThrough(), {
        stderr: new PassThrough(),
        close() {
          this.destroy()
        }
      })
      callback(null, channel)
      queueMicrotask(() => channel.write('Change now? [Y/N]:'))
    }
  }
}))

const { agentConnectionContext, getOrCreateAgentLink, disconnectAgentLink } =
  await import('../src/main/ai/agentLinks')
const { connectRemoteExecution } = await import('../src/main/ai/exec')
const host = {
  id: 'switch',
  name: 'switch',
  host: 'switch.test',
  port: 22,
  username: 'admin',
  authType: 'password',
  connectTimeout: 2000,
  keepaliveInterval: 5000,
  jumpHostIds: []
} as unknown as HostConnection

afterEach(() => {
  agentConnectionContext.run('test', () => disconnectAgentLink(host.id))
  probes.exec.mockReset()
})

it('agent shell opens without an unsolicited exec probe consuming the first channel', async () => {
  // Model a switch that terminates a connection when its first request is an exec probe.
  probes.exec.mockImplementation(async (client: EventEmitter) => {
    client.emit('close')
    throw new Error('No response from server')
  })
  await agentConnectionContext.run('test', async () => {
    const link = getOrCreateAgentLink(host)
    link.start()
    await link.waitForActive(1000)
    const output: string[] = []
    const transport = await connectRemoteExecution(link.activeClient!, '', {
      data: (chunk) => output.push(chunk),
      exit: vi.fn(),
      lost: vi.fn()
    })
    await Promise.resolve()
    expect(probes.exec).not.toHaveBeenCalled()
    expect(output.join('')).toContain('Change now? [Y/N]:')
    transport.close()
  })
})

it('peer close invalidates the authenticated client even with keepalive enabled', async () => {
  await agentConnectionContext.run('test', async () => {
    const link = getOrCreateAgentLink(host)
    link.start()
    await link.waitForActive(1000)
    link.activeClient!.emit('close')
    expect(link.isActive).toBe(false)
    expect(link.activeClient).toBeNull()
  })
})
