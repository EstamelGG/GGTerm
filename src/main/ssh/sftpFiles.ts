import type { Client, SFTPWrapper } from 'ssh2'
import type { EncodingMode, FileEncoding } from '../../shared/encoding'
import { joinPath, linkTargetFromLongname } from '../../shared/sftpPath'
import type { SftpEditPayload, SftpEntry, SftpListing, SftpStat } from '../../shared/types'
import { appLog } from '../log'
import { writeRemoteAtomic } from './atomicFile'
import { removeDirCommand } from './remoteScripts'
import { ResourceLifetime } from './resourceLifetime'
import { decodeFile, encodeFile } from './textEncoding'
export type SftpRequest = <T>(
  channel: SFTPWrapper | null,
  fn: (cb: (err: Error | null | undefined, res?: T) => void) => void
) => Promise<T>

/** ssh2 Stats 的子集（结构兼容；权限位在 mode） */
export interface SftpStats {
  size: number
  uid: number
  gid: number
  mode: number
  atime: number
  mtime: number
}

export interface SftpFileEntry {
  filename: string
  longname: string
  attrs: SftpStats
}

/** 在共享连接上执行命令并收集输出（对照 executeCommand；目录删除用） */
export function execCommand(
  client: Client,
  command: string,
  maxBytes = 65536,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    let channel: import('ssh2').ClientChannel | undefined
    let settled = false
    let out = ''
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(out)
    }
    const abort = (): void => {
      finish(new Error('SSH resource invalidated'))
      channel?.close()
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    try {
      client.exec(command, (err, stream) => {
        if (settled) {
          stream?.on('error', () => {})
          stream?.close()
          return
        }
        if (err || !stream) {
          finish(err ?? new Error('exec failed'))
          return
        }
        channel = stream
        const data = (d: Buffer): void => {
          if (!settled && out.length < maxBytes) out += d.toString('utf8')
        }
        stream.on('data', data)
        stream.stderr.on('data', data)
        stream.on('close', () => finish())
        stream.on('error', finish)
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** ssh2 FileEntry → SftpEntry（对照 SftpController.entry） */
export function entryFrom(f: SftpFileEntry, dir: string): SftpEntry | null {
  if (f.filename === '.' || f.filename === '..') return null
  const mode = f.attrs.mode ?? 0
  const type = mode & 0o170000
  const isDir = type === 0o040000 || f.longname.startsWith('d')
  const isLink = type === 0o120000 || f.longname.startsWith('l')
  return {
    name: f.filename,
    path: joinPath(dir, f.filename),
    isDir,
    isLink,
    size: f.attrs.size ?? 0,
    permissions: f.attrs.mode ?? null,
    uid: f.attrs.uid ?? null,
    gid: f.attrs.gid ?? null,
    accessed: f.attrs.atime ? f.attrs.atime * 1000 : null,
    modified: f.attrs.mtime ? f.attrs.mtime * 1000 : null,
    longname: f.longname,
    linkTarget: isLink ? linkTargetFromLongname(f.longname) : null
  }
}
export class SftpFiles {
  private realpathCache = new Map<string, string>()
  constructor(
    private readonly ensureChannel: () => Promise<SFTPWrapper>,
    private readonly request: SftpRequest,
    private readonly getClient: () => Client | null,
    private readonly channelLifetime: ResourceLifetime
  ) {}
  private get client(): Client | null {
    return this.getClient()
  }
  clearCache(): void {
    this.realpathCache.clear()
  }

  /* ---------------- 查询操作 ---------------- */

  /** readdir + realpath（符号链接目录解析为真实路径；对照 load() 的取数部分） */
  async list(path: string): Promise<SftpListing> {
    const sftp = await this.ensureChannel()
    const [raw, resolved] = await Promise.all([
      this.request<SftpFileEntry[]>(sftp, (cb) => sftp.readdir(path, cb)),
      this.request<string>(sftp, (cb) => sftp.realpath(path, cb)).catch(() => path)
    ])
    const entries = raw.map((f) => entryFrom(f, resolved)).filter((e): e is SftpEntry => e !== null)
    appLog('sftp', `List directory "${path}" → ${entries.length} entries`)
    return { resolved, entries }
  }

  /** 仅 readdir（测量专用：省去 realpath 往返，取消后在途请求减半） */
  async listEntries(path: string): Promise<SftpEntry[]> {
    const sftp = await this.ensureChannel()
    const raw = await this.request<SftpFileEntry[]>(sftp, (cb) => sftp.readdir(path, cb))
    const entries = raw.map((f) => entryFrom(f, path)).filter((e): e is SftpEntry => e !== null)
    appLog('sftp', `List directory "${path}" → ${entries.length} entries`)
    return entries
  }

  async realpath(path: string): Promise<string> {
    const hit = this.realpathCache.get(path)
    if (hit) return hit
    const sftp = await this.ensureChannel()
    const resolved = await this.request<string>(sftp, (cb) => sftp.realpath(path, cb)).catch(
      () => null
    )
    if (resolved === null) return path // 通道暂时不可用不缓存，避免固化错误结果
    this.realpathCache.set(path, resolved)
    return resolved
  }

  async readlink(path: string): Promise<string> {
    const sftp = await this.ensureChannel()
    return this.request<string>(sftp, (cb) => sftp.readlink(path, cb)).catch(() => '')
  }

  async stat(path: string): Promise<SftpStat> {
    const sftp = await this.ensureChannel()
    const attrs = await this.request<SftpStats>(sftp, (cb) => sftp.stat(path, cb))
    return {
      size: attrs.size ?? 0,
      permissions: attrs.mode ?? null,
      uid: attrs.uid ?? null,
      gid: attrs.gid ?? null,
      accessed: attrs.atime ? attrs.atime * 1000 : null,
      modified: attrs.mtime ? attrs.mtime * 1000 : null,
      childFiles: null,
      childDirs: null
    }
  }

  /** 目录详情：stat + 子项计数（对照 itemDetail） */
  async itemDetail(path: string): Promise<SftpStat> {
    const base = await this.stat(path)
    try {
      const kids = await this.list(path)
      return {
        ...base,
        childFiles: kids.entries.filter((e) => !e.isDir).length,
        childDirs: kids.entries.filter((e) => e.isDir).length
      }
    } catch {
      return base
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch {
      return false
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    const sftp = await this.ensureChannel()
    try {
      const attrs = await this.request<SftpStats>(sftp, (cb) => sftp.stat(path, cb))
      return (attrs.mode & 0o170000) === 0o040000
    } catch {
      return false
    }
  }

  /* ---------------- 变更操作 ---------------- */

  async mkdir(path: string): Promise<void> {
    const sftp = await this.ensureChannel()
    await this.request<null>(sftp, (cb) => sftp.mkdir(path, cb))
  }

  async touch(path: string): Promise<void> {
    const sftp = await this.ensureChannel()
    const handle = await this.request<Buffer>(sftp, (cb) => sftp.open(path, 'w', cb))
    await this.request<null>(sftp, (cb) => sftp.close(handle, cb))
  }

  async rename(src: string, dest: string): Promise<void> {
    const sftp = await this.ensureChannel()
    await this.request<null>(sftp, (cb) => sftp.rename(src, dest, cb))
  }

  async chmod(path: string, mode: number): Promise<void> {
    const sftp = await this.ensureChannel()
    await this.request<null>(sftp, (cb) => sftp.chmod(path, mode, cb))
  }

  /* ---------------- 远程编辑（阶段⑤，对照 readForEdit/writeText） ---------------- */

  private static readonly EDIT_MAX_BYTES = 10 * 1024 * 1024

  async readForEdit(
    path: string,
    _knownSize: number,
    encoding: EncodingMode = 'auto'
  ): Promise<SftpEditPayload> {
    const limit = SftpFiles.EDIT_MAX_BYTES
    const sftp = await this.ensureChannel()
    const handle = await this.request<Buffer>(sftp, (cb) => sftp.open(path, 'r', cb))
    try {
      const chunks: Buffer[] = []
      let offset = 0
      for (;;) {
        const buf = Buffer.alloc(64_000)
        const n = await this.request<number>(sftp, (cb) =>
          sftp.read(handle, buf, 0, buf.length, offset, (err, bytesRead) => cb(err, bytesRead))
        )
        if (n <= 0) break
        chunks.push(n === buf.length ? buf : buf.subarray(0, n))
        offset += n
        if (offset > limit) return { kind: 'tooLarge' }
      }
      return { kind: 'text', ...decodeFile(Buffer.concat(chunks), encoding), size: offset }
    } finally {
      await this.request<null>(sftp, (cb) => sftp.close(handle, cb)).catch(() => {})
    }
  }

  async writeText(
    path: string,
    text: string,
    encoding: FileEncoding = 'utf8',
    bom = false
  ): Promise<void> {
    const data = encodeFile(text, encoding, bom)
    const sftp = await this.ensureChannel()
    await writeRemoteAtomic(sftp, path, data, (action) => this.request(sftp, action))
  }

  async unlink(path: string): Promise<void> {
    const sftp = await this.ensureChannel()
    await this.request<null>(sftp, (cb) => sftp.unlink(path, cb))
  }

  /** 删除：文件走 unlink；目录走共享连接 exec rm -rf（对照 remove()） */
  async remove(entry: SftpEntry): Promise<void> {
    if (entry.isDir) {
      const client = this.client
      if (!client) throw new Error('host link not active')
      const lease = this.channelLifetime.capture(client)
      const resolved = await this.realpath(entry.path)
      await execCommand(client, removeDirCommand(resolved), 65536, lease.signal)
      return
    }
    await this.unlink(entry.path)
  }
}
