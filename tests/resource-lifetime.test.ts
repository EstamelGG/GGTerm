import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { expect, it } from 'vitest'
import {
  bindTransport,
  invalidateTransport,
  ResourceLifetime
} from '../src/main/ssh/resourceLifetime'

it('isolates resource instances and invalidates every lease of a lost transport', () => {
  const client = new EventEmitter() as Client
  bindTransport(client, 'connection', 7)
  const shell = new ResourceLifetime('host', 'shell')
  const sftp = new ResourceLifetime('host', 'sftp')
  const old = shell.capture(client)
  const files = sftp.capture(client)
  expect(old.identity).toMatchObject({ connectionId: 'connection', connectionGeneration: 7 })
  expect(files.identity.resourceId).not.toBe(old.identity.resourceId)
  shell.reset()
  expect(old.signal.aborted).toBe(true)
  expect(files.current()).toBe(true)
  const fresh = shell.capture(client)
  expect(fresh.identity.resourceId).toBe(old.identity.resourceId)
  expect(fresh.identity.generation).toBe(old.identity.generation + 1)
  client.emit('end')
  expect(fresh.current()).toBe(false)
  expect(files.current()).toBe(false)
  expect(sftp.capture(client).current()).toBe(false)
})

it('cannot revive a transport invalidated before its first resource was created', () => {
  const client = new EventEmitter() as Client
  invalidateTransport(client)
  expect(new ResourceLifetime('host', 'perf').capture(client).current()).toBe(false)
})
