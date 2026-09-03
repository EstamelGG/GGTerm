import type { SftpEntry } from './types'

/**
 * SFTP 路径与权限纯函数（对照 SftpController 静态方法 + SftpPathGuard.swift
 * + SftpItemDetail.modeString/parseLongname）。主进程与渲染层共用。
 */

export function joinPath(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  if (dir.endsWith('/')) return dir + name
  return `${dir}/${name}`
}

export function parentPath(path: string): string {
  let p = path
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  const i = p.lastIndexOf('/')
  if (i < 0) return '/'
  return p.slice(0, i) || '/'
}

export function normalizePath(path: string): string {
  let p = path.trim()
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p === '' ? '/' : p
}

export function isUnderPath(path: string, root: string): boolean {
  if (root === '/') return path.startsWith('/')
  return path === root || path.startsWith(`${root}/`)
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** 目录作为单个参数传入，仅允许显式的 ~/ 前缀展开为 home。 */
export function shellDirectoryCommand(path: string): string {
  if (path === '~') return 'cd ~'
  if (path.startsWith('~/')) return `cd ~/${shellQuote(path.slice(2))}`
  // 相对路径加 ./，避免以 - 开头的目录被 cd 当作选项。
  return `cd ${shellQuote(path.startsWith('/') ? path : `./${path}`)}`
}

/* ---------------- 权限格式化（对照 SftpItemDetail） ---------------- */

export function modeString(mode: number | null, isDir: boolean, isLink: boolean): string {
  let type: string
  if (mode !== null) {
    switch (mode & 0o170000) {
      case 0o040000:
        type = 'd'
        break
      case 0o120000:
        type = 'l'
        break
      case 0o020000:
        type = 'c'
        break
      case 0o060000:
        type = 'b'
        break
      case 0o010000:
        type = 'p'
        break
      case 0o140000:
        type = 's'
        break
      default:
        type = isLink ? 'l' : isDir ? 'd' : '-'
    }
  } else {
    type = isLink ? 'l' : isDir ? 'd' : '-'
  }
  const perm = (mode ?? 0) & 0o777
  const marks = 'rwxrwxrwx'
  let body = ''
  for (let i = 0; i < 9; i++) {
    body += (perm & (1 << (8 - i))) !== 0 ? marks[i] : '-'
  }
  if (mode !== null) {
    const chars = body.split('')
    if ((mode & 0o4000) !== 0) chars[2] = chars[2] === 'x' ? 's' : 'S'
    if ((mode & 0o2000) !== 0) chars[5] = chars[5] === 'x' ? 's' : 'S'
    if ((mode & 0o1000) !== 0) chars[8] = chars[8] === 'x' ? 't' : 'T'
    body = chars.join('')
  }
  return `${type}${body}`
}

export function modeOctal(mode: number | null): string {
  if (mode === null) return '—'
  return (mode & 0o7777).toString(8).padStart(4, '0')
}

/** longname → owner/group/nlink（对照 SftpItemDetail.parseLongname） */
export function parseLongname(longname: string): {
  owner: string | null
  group: string | null
  nlink: string | null
} {
  const parts = longname.split(/\s+/).filter(Boolean)
  if (parts.length < 4) return { owner: null, group: null, nlink: null }
  return { owner: parts[2], group: parts[3], nlink: parts[1] }
}

/** longname → 链接目标（" -> " 后段） */
export function linkTargetFromLongname(longname: string): string | null {
  const i = longname.indexOf(' -> ')
  if (i < 0) return null
  const target = longname.slice(i + 4).trim()
  return target === '' ? null : target
}

/* ---------------- PathGuard（危险路径护栏） ---------------- */

export interface SftpGuardHit {
  path: string
  label: string
}

/** 精确路径黑名单——子路径（如 /home/user）不拦截 */
const BLOCKED_EXACT = new Set([
  '/',
  '/home',
  '/root',
  '/etc',
  '/etc/shadow',
  '/etc/passwd',
  '/boot',
  '/bin',
  '/sbin',
  '/usr',
  '/lib',
  '/lib64',
  '/var',
  '/sys',
  '/proc',
  '/dev'
])

export function guardHits(paths: string[]): SftpGuardHit[] {
  const seen = new Set<string>()
  const out: SftpGuardHit[] = []
  for (const raw of paths) {
    const normalized = normalizePath(raw)
    if (!BLOCKED_EXACT.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    out.push({ path: normalized, label: normalized })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** 移动合法性：不可移到自身/原父目录；目录不可移进自己的子树 */
export function canMove(entry: SftpEntry, destDir: string): boolean {
  const dest = normalizePath(destDir)
  const src = normalizePath(entry.path)
  const parent = normalizePath(parentPath(entry.path))
  if (src === dest || parent === dest) return false
  if (entry.isDir && (dest === src || dest.startsWith(`${src}/`))) return false
  return true
}
