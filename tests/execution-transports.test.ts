import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { Client } from 'ssh2'
import { connectRemoteExecution } from '../src/main/ai/exec'

function fixture(): {
  client: Client
  channel: EventEmitter & {
    stderr: EventEmitter
    write: ReturnType<typeof vi.fn>
    setWindow: ReturnType<typeof vi.fn>
    writable: boolean
  }
  shell: ReturnType<typeof vi.fn>
} {
  const channel = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    write: vi.fn(),
    setWindow: vi.fn(),
    writable: true
  })
  const shell = vi.fn((_options, callback) => callback(null, channel))
  return {
    client: Object.assign(new EventEmitter(), { shell }) as unknown as Client,
    channel,
    shell
  }
}

it('allocates a PTY, preserves split UTF-8, and drains output before returning the exit status', async () => {
  const { client, channel, shell } = fixture()
  const chunks: string[] = []
  const exit = vi.fn()
  const lost = vi.fn()
  const transport = await connectRemoteExecution(client, 'script', {
    data: (chunk) => chunks.push(chunk),
    exit,
    lost
  })
  expect(shell.mock.calls[0][0]).toMatchObject({ term: 'xterm-256color' })
  expect(channel.write).toHaveBeenCalledWith('script\n')
  const text = Buffer.from('中文')
  channel.emit('data', text.subarray(0, 2))
  channel.emit('data', text.subarray(2))
  transport.write('answer\n')
  expect(channel.write).toHaveBeenCalledWith('answer\n')
  channel.emit('exit', 7)
  expect(exit).not.toHaveBeenCalled()
  channel.emit('data', Buffer.from('tail'))
  channel.emit('close')
  expect(chunks.join('')).toBe('中文tail')
  expect(exit).toHaveBeenCalledWith(7, undefined)
  expect(lost).not.toHaveBeenCalled()
  expect(client.listenerCount('close')).toBe(0)
})

it('opens an empty shell and captures switch login prompts without sending a command', async () => {
  const { client, channel } = fixture()
  const data = vi.fn()
  await connectRemoteExecution(client, '', { data, exit: vi.fn(), lost: vi.fn() })
  const prompt = 'The password needs to be changed. Change now? [Y/N]:'
  channel.emit('data', Buffer.from(prompt))
  expect(data).toHaveBeenCalledWith(prompt)
  expect(channel.write).not.toHaveBeenCalled()
  channel.emit('close')
})

it('distinguishes a failed shell request from SSH authentication failure', async () => {
  const { client, shell } = fixture()
  shell.mockImplementation((_options, callback) => callback(new Error('No response from server')))
  await expect(
    connectRemoteExecution(client, '', {
      data: vi.fn(),
      exit: vi.fn(),
      lost: vi.fn()
    })
  ).rejects.toThrow(
    'SSH authenticated, but opening the PTY/shell channel failed: No response from server'
  )
})

it('channel closure without exit status is unknown, never a successful completion', async () => {
  const { client, channel } = fixture()
  const exit = vi.fn()
  const lost = vi.fn()
  await connectRemoteExecution(client, 'script', { data: vi.fn(), exit, lost })
  channel.emit('close')
  client.emit('close')
  expect(exit).not.toHaveBeenCalled()
  expect(lost).toHaveBeenCalledOnce()
})

it('interrupt writes the PTY interrupt character without closing or restarting the channel', async () => {
  const { client, channel, shell } = fixture()
  const transport = await connectRemoteExecution(client, 'script', {
    data: vi.fn(),
    exit: vi.fn(),
    lost: vi.fn()
  })
  transport.interrupt()
  expect(channel.write).toHaveBeenCalledWith('\x03')
  expect(shell).toHaveBeenCalledOnce()
  channel.emit('exit', null, 'INT')
  channel.emit('close')
})
