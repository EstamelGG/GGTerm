import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { writeRemoteAtomic } from '../src/main/ssh/atomicFile'

function remote(fail?: 'write' | 'close' | 'rename' | 'unsupported'): {
  sftp: Record<string, ReturnType<typeof vi.fn>>
  files: Map<string, Buffer>
} {
  const files = new Map<string, Buffer>([['/target', Buffer.from('original')]])
  const attrs = { uid: 1000, gid: 1000, mode: 0o100640 }
  let temp = ''
  const sftp = {
    realpath: vi.fn((_path, cb) => cb(null, '/target')),
    stat: vi.fn((_path, cb) => cb(null, attrs)),
    open: vi.fn((path, flags, _attrs, cb) => {
      expect(flags).toBe('wx')
      temp = path
      files.set(path, Buffer.alloc(0))
      cb(null, Buffer.from(path))
    }),
    write: vi.fn((_handle, data, _offset, _length, _position, cb) => {
      if (fail === 'write') cb(new Error('disk full'))
      else {
        files.set(temp, data)
        cb(null)
      }
    }),
    fstat: vi.fn((_handle, cb) => cb(null, attrs)),
    fchmod: vi.fn((_handle, _mode, cb) => cb(null)),
    ext_openssh_fsync: vi.fn((_handle, cb) => cb(null)),
    close: vi.fn((_handle, cb) => cb(fail === 'close' ? new Error('close failed') : null)),
    ext_openssh_rename: vi.fn((src, dest, cb) => {
      if (fail === 'unsupported') throw new Error('Server does not support this extended request')
      else if (fail === 'rename') cb(new Error('permission denied'))
      else {
        files.set(dest, files.get(src)!)
        files.delete(src)
        cb(null)
      }
    }),
    rename: vi.fn((_src, _dest, cb) => cb(new Error('target exists'))),
    unlink: vi.fn((path, cb) => {
      expect(path).not.toBe('/target')
      files.delete(path)
      cb(null)
    })
  }
  return { sftp, files }
}

describe('atomic remote saves', () => {
  it('replaces the resolved target only after write, permission preservation and close succeed', async () => {
    const { sftp, files } = remote()
    await writeRemoteAtomic(sftp as unknown as SFTPWrapper, '/symlink', Buffer.from('updated'))
    expect(files.get('/target')?.toString()).toBe('updated')
    expect(files.size).toBe(1)
    expect(sftp.fchmod).toHaveBeenCalledWith(expect.any(Buffer), 0o640, expect.any(Function))
    expect(sftp.close.mock.invocationCallOrder[0]).toBeLessThan(
      sftp.ext_openssh_rename.mock.invocationCallOrder[0]
    )
  })
  it.each(['write', 'close', 'rename', 'unsupported'] as const)(
    'preserves the original when %s fails',
    async (failure) => {
      const { sftp, files } = remote(failure)
      await expect(
        writeRemoteAtomic(sftp as unknown as SFTPWrapper, '/target', Buffer.from('updated'))
      ).rejects.toThrow()
      expect(files.get('/target')?.toString()).toBe('original')
      expect(files.size).toBe(1)
    }
  )
})
