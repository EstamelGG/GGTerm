import { describe, expect, it } from 'vitest'
import { isLocalAccessErrno, protectedFolderOf } from '../src/main/localAccess'

describe('localAccess', () => {
  it('detects EPERM/EACCES errno codes', () => {
    expect(isLocalAccessErrno(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true)
    expect(isLocalAccessErrno(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true)
    expect(isLocalAccessErrno(new Error('other'))).toBe(false)
  })

  it('classifies paths under Downloads/Documents/Desktop on darwin', () => {
    if (process.platform !== 'darwin') return
    const home = process.env.HOME!
    expect(protectedFolderOf(`${home}/Downloads/a.txt`)).toBe('downloads')
    expect(protectedFolderOf(`${home}/Documents/a.txt`)).toBe('documents')
    expect(protectedFolderOf(`${home}/Desktop/a.txt`)).toBe('desktop')
    expect(protectedFolderOf(`${home}/Movies/a.txt`)).toBeNull()
  })
})
