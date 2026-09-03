import { beforeEach, describe, expect, it, vi } from 'vitest'
const data = vi.hoisted(() => ({ hosts: {} as Record<string, string> }))
vi.mock('electron-store', () => ({
  default: class {
    get(): Record<string, string> {
      return data.hosts
    }
    set(_key: string, hosts: Record<string, string>): void {
      data.hosts = hosts
    }
  }
}))
import { createHostVerifier } from '../src/main/ssh/hostKeys'
import { selectAuth } from '../src/shared/sshAuth'

beforeEach(() => {
  data.hosts = {}
})
describe('SSH trust on first use', () => {
  it('automatically persists first fingerprint, accepts same key and rejects a changed key', () => {
    expect(createHostVerifier('SERVER', 22).verify(Buffer.from('key A'))).toBe(true)
    expect(createHostVerifier('server', 22).verify(Buffer.from('key A'))).toBe(true)
    const changed = createHostVerifier('server', 22)
    expect(changed.verify(Buffer.from('key B'))).toBe(false)
    expect(changed.error()?.message).toMatch(/Host key changed.*server:22/)
    expect(createHostVerifier('server', 22).verify(Buffer.from('key A'))).toBe(true)
    expect(Object.keys(data.hosts)).toHaveLength(1)
  })
  it('separates endpoints by port and normalizes IPv6 brackets', () => {
    expect(createHostVerifier('[::1]', 22).verify(Buffer.from('A'))).toBe(true)
    expect(createHostVerifier('::1', 22).verify(Buffer.from('B'))).toBe(false)
    expect(createHostVerifier('::1', 2222).verify(Buffer.from('B'))).toBe(true)
  })
})
it('uses the selected authentication mode even if both secrets are retained', () => {
  const secrets = { password: 'password', privateKey: 'old key', passphrase: 'old passphrase' }
  expect(selectAuth('password', secrets)).toEqual({ password: 'password' })
  expect(selectAuth('privateKey', secrets)).toEqual({
    privateKey: 'old key',
    passphrase: 'old passphrase'
  })
})
