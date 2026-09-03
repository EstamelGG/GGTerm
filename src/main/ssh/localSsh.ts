import { homedir, userInfo } from 'node:os'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { LocalSshKey, SshConfigHost } from '../../shared/types'

/**
 * ~/.ssh 集成（对照 XTerminal：密钥选择器 + config 导入）。
 * 只做三件无副作用的事：列私钥 / 读私钥 / 解析 config；导入编排由渲染层驱动。
 */

const HOME = homedir()
const SSH_DIR = join(HOME, '.ssh')

/** ~/.ssh 中的非密钥文件（.pub 已另行排除） */
const NON_KEY_NAMES = new Set([
  'config',
  'known_hosts',
  'known_hosts.old',
  'authorized_keys',
  'authorized_keys2',
  'environment',
  'rc'
])

const KEY_MAX_BYTES = 256 * 1024

/** 私钥特征：OpenSSH/PEM/PKCS#8 头或 PuTTY ppk 头 */
function looksLikePrivateKey(text: string): boolean {
  return text.includes('-----BEGIN') || text.startsWith('PuTTY-User-Key')
}

/** 列出 ~/.ssh 下的私钥（读首段内容验证，防把普通文件当密钥）；目录不存在返回空 */
export async function listLocalKeys(): Promise<LocalSshKey[]> {
  let names: string[]
  try {
    names = await readdir(SSH_DIR)
  } catch {
    return []
  }
  const out: LocalSshKey[] = []
  for (const name of names) {
    if (name.startsWith('.') || name.endsWith('.pub') || NON_KEY_NAMES.has(name)) continue
    const path = join(SSH_DIR, name)
    try {
      const st = await stat(path)
      if (!st.isFile() || st.size > KEY_MAX_BYTES) continue
      const head = (await readFile(path, 'utf8')).slice(0, 64)
      if (!looksLikePrivateKey(head)) continue
      out.push({ name, path })
    } catch {
      // 不可读/异常条目直接跳过
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 读私钥内容：限定家目录内 + 大小上限 + 内容验证 */
export async function readLocalKey(path: string): Promise<string> {
  const root = resolve(HOME)
  const resolved = resolve(path)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error('key file must be under home directory')
  }
  const st = await stat(resolved)
  if (!st.isFile() || st.size > KEY_MAX_BYTES) throw new Error('not a private key file')
  const text = await readFile(resolved, 'utf8')
  if (!looksLikePrivateKey(text)) throw new Error('not a private key file')
  return text
}

/* ---------------- ~/.ssh/config 解析 ---------------- */

/** Host 块：patterns 匹配别名（* ? 通配，! 取反）；props 为块内首个取值（OpenSSH first-wins） */
interface ConfigBlock {
  patterns: string[]
  negations: string[]
  hostName?: string
  user?: string
  port?: number
  identityFiles: string[]
}

/** ssh 通配匹配（大小写不敏感；* 任意 / ? 单字符） */
function patternMatches(pattern: string, host: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
    'i'
  )
  return re.test(host)
}

/** ~ / ~/xxx 展开为家目录绝对路径 */
function expandTilde(p: string): string {
  if (p === '~') return HOME
  if (p.startsWith('~/')) return join(HOME, p.slice(2))
  return p
}

/**
 * 解析 ~/.ssh/config：文件缺失/不可读返回空数组。
 * 语义对齐 OpenSSH：逐块扫描、first-obtained-wins（含 Host * 兜底块）；
 * Include 指令不支持（跳过）。无 HostName 的块用别名兜底。
 */
export async function parseSshConfig(): Promise<SshConfigHost[]> {
  let text: string
  try {
    text = await readFile(join(SSH_DIR, 'config'), 'utf8')
  } catch {
    return []
  }

  const blocks: ConfigBlock[] = []
  let cur: ConfigBlock | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*[= ]\s*(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      cur = { patterns: [], negations: [], identityFiles: [] }
      for (const p of value.split(/\s+/)) {
        if (p.startsWith('!')) cur.negations.push(p.slice(1))
        else cur.patterns.push(p)
      }
      blocks.push(cur)
    } else if (cur) {
      if (key === 'hostname' && cur.hostName === undefined) cur.hostName = value
      else if (key === 'user' && cur.user === undefined) cur.user = value
      else if (key === 'port' && cur.port === undefined) cur.port = Number.parseInt(value, 10)
      else if (key === 'identityfile') cur.identityFiles.push(expandTilde(value))
    }
  }

  // 别名 = 所有不带通配符的 Host 图样
  const aliases = [...new Set(blocks.flatMap((b) => b.patterns.filter((p) => !/[*?]/.test(p))))]

  const fallbackUser = userInfo().username
  return aliases.map((alias) => {
    let host = ''
    let user = ''
    let port = 0
    let identityFile = ''
    for (const b of blocks) {
      if (b.negations.some((p) => patternMatches(p, alias))) continue
      if (!b.patterns.some((p) => patternMatches(p, alias))) continue
      if (!host && b.hostName) host = b.hostName
      if (!user && b.user) user = b.user
      if (!port && b.port) port = b.port
      if (!identityFile && b.identityFiles.length > 0) identityFile = b.identityFiles[0]
    }
    return {
      alias,
      host: host || alias,
      user: user || fallbackUser,
      port: port > 0 ? port : 22,
      identityFile
    }
  })
}
