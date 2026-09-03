import { beforeEach, expect, it, vi } from 'vitest'
import { safeStorage } from 'electron'
import { open, seal } from '../src/main/data/secretCodec'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().slice('encrypted:'.length))
  }
}))
beforeEach(() => vi.clearAllMocks())

it('preserves the existing encrypted storage format', () => {
  const stored = seal('密码')
  expect(stored).toBe(`enc:${Buffer.from('encrypted:密码').toString('base64')}`)
  expect(open(stored)).toBe('密码')
})
it('supports plaintext fallback and empty or unreadable legacy values', () => {
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)
  expect(open(seal('密码'))).toBe('密码')
  expect(seal('')).toBe('')
  expect(open(undefined)).toBe('')
  expect(open('unknown')).toBe('')
  vi.mocked(safeStorage.decryptString).mockImplementationOnce(() => {
    throw new Error('locked')
  })
  expect(open('enc:AAAA')).toBe('')
})
