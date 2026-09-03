import { promises as fsp, createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { join as joinLocal, basename, parse } from 'path'
import { app, dialog, shell } from 'electron'
import type { Client, SFTPWrapper } from 'ssh2'
import { receiveArchive, extractArchive } from './archiveDownload'
import type {
  SftpEditPayload,
  SftpEntry,
  SftpListing,
  SftpStateEvent,
  SftpStat,
  SftpTransferMirror
} from '../../shared/types'
import { joinPath, linkTargetFromLongname, shellQuote } from '../../shared/sftpPath'
import { errorMessage } from '../../shared/error'
import { appLog } from '../log'
import type { HostLink, HostLinkEvents } from './link'
import { removeDirCommand } from './remoteScripts'
import type { EncodingMode, FileEncoding } from '../../shared/encoding'
import { decodeFile, encodeFile } from './textEncoding'
import { writeRemoteAtomic } from './atomicFile'
import { TransferTask } from './transferTask'
import { localAccessDeniedError } from '../localAccess'

/**
 * 对照 ATerminal-Swift Services/SftpController.swift：
 * - 挂在主机共享 SSH 连接上开 SFTP 通道；断线由主机级信号统一驱动（无自主重连）
 * - 树状态（children 缓存/expanded/显隐）留在渲染层 —— 本类只做无状态操作
 * - 传输用 ssh2 fastGet/fastPut（step 回调累计进度，对照手写 chunk 循环）
 */

type SftpEvents = Pick<HostLinkEvents, 'onSftpState' | 'onSftpTransfer' | 'onSftpMeasure'>

/** ssh2 Stats 的子集（结构兼容；权限位在 mode） */
interface SftpStats {
  size: number
  uid: number
  gid: number
  mode: number
  atime: number
  mtime: number
}

interface SftpFileEntry {
  filename: string
  longname: string
  attrs: SftpStats
}

/** 统一 ssh2 回调风格（err 可为 undefined）为 Promise */
function p<T>(fn: (cb: (err: Error | null | undefined, res?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, res) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve(res as T)
    })
  })
}

/** 在共享连接上执行命令并收集输出（对照 executeCommand；目录删除用） */
export function execCommand(client: Client, command: string, maxBytes = 65536): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('exec failed'))
        return
      }
      let out = ''
      stream.on('data', (d: Buffer) => {
        if (out.length < maxBytes) out += d.toString('utf8')
      })
      stream.stderr.on('data', (d: Buffer) => {
        if (out.length < maxBytes) out += d.toString('utf8')
      })
      stream.on('close', () => resolve(out))
      stream.on('error', reject)
    })
  })
}

export class SftpSession {
  private sftp: SFTPWrapper | null = null
  private started = false
  private transfers: SftpTransferMirror[] = []
  /** 进度采样基准（速度差值）：xfer.id → {at, bytes} */
  private tickAt = new Map<string, { at: number; bytes: number }>()
  /** 进度事件节流标记：xfer.id → 上次 emit 时刻 */
  private lastEmitAt = new Map<string, number>()
  private measureAbort: AbortController | null = null
  /** 当前测度的任务队列引用：取消时直接清空，worker 立即断供（不再发起 readdir） */
  private measureQueue: string[] | null = null
  private readonly tasks = new Map<string, TransferTask>()
  private readonly cleanupPaths = new Map<string, Set<string>>()
  private readonly cleaning = new Set<string>()

  private queueCleanup(xfer: SftpTransferMirror, path: string): void {
    const paths = this.cleanupPaths.get(xfer.id) ?? new Set<string>()
    paths.add(path)
    this.cleanupPaths.set(xfer.id, paths)
  }

  async retryCleanup(id: string): Promise<void> {
    const paths = this.cleanupPaths.get(id)
    const xfer = this.transfers.find((item) => item.id === id)
    if (!paths?.size || !xfer || this.cleaning.has(id)) return
    this.cleaning.add(id)
    xfer.cleanup = 'pending'
    xfer.cleanupError = undefined
    const emit = (): void =>
      this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
    emit()
    const errors: string[] = []
    for (const path of paths) {
      try {
        await fsp.rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
        paths.delete(path)
      } catch (error) {
        errors.push(`${path}: ${errorMessage(error)}`)
      }
    }
    this.cleaning.delete(id)
    xfer.cleanup = errors.length ? 'error' : undefined
    xfer.cleanupError = errors.length ? errors.join('\n') : undefined
    if (!paths.size) this.cleanupPaths.delete(id)
    emit()
  }
  private channelLock: Promise<SFTPWrapper> | null = null
  /** realpath 结果缓存（同路径重复浏览零往返；仅成功结果入缓存） */
  private realpathCache = new Map<string, string>()

  constructor(
    private readonly link: HostLink,
    private readonly events: SftpEvents
  ) {}

  /** 渲染层面板激活时调用：链路未活则等待（≤15s），再开通道 —— 首连事件竞态兜底 */
  async start(): Promise<void> {
    this.started = true
    if (!this.client) await this.link.waitForActive()
    await this.ensureChannel()
  }

  stop(): void {
    this.started = false
    this.abortMeasure()
    this.teardown()
  }

  /** 主机链路丢失 —— 通道作废；恢复仅由 hostLinkRestored 驱动 */
  hostLinkLost(): void {
    if (!this.started) return
    this.teardown()
    this.emitState('disconnected')
  }

  /** 主机链路（重）建立 —— 重开通道；目录刷新由渲染层监听 host:state 驱动 */
  hostLinkRestored(): void {
    if (!this.started) return
    void this.ensureChannel()
  }

  /* ---------------- 通道 ---------------- */

  private get client(): Client | null {
    return this.link.activeClient
  }

  private async ensureChannel(): Promise<SFTPWrapper> {
    if (this.sftp) return this.sftp
    if (this.channelLock) return this.channelLock
    const client = this.client
    if (!client) throw new Error('host link not active')
    this.emitState('connecting')
    this.channelLock = p<SFTPWrapper>((cb) => client.sftp(cb))
      .then((sftp) => {
        this.sftp = sftp
        this.channelLock = null
        this.emitState('connected')
        return sftp
      })
      .catch((err: Error) => {
        this.channelLock = null
        this.teardown()
        this.emitState('error', err.message)
        throw err
      })
    return this.channelLock
  }

  private teardown(): void {
    for (const task of this.tasks.values()) task.cancel()
    const current = this.sftp
    this.sftp = null
    this.channelLock = null
    if (current) {
      try {
        current.end()
      } catch {
        /* ignore */
      }
    }
  }

  private emitState(status: SftpStateEvent['status'], error?: string): void {
    this.events.onSftpState({ hostId: this.link.hostId, status, error })
  }

  /* ---------------- 查询操作 ---------------- */

  /** readdir + realpath（符号链接目录解析为真实路径；对照 load() 的取数部分） */
  async list(path: string): Promise<SftpListing> {
    const sftp = await this.ensureChannel()
    const [raw, resolved] = await Promise.all([
      p<SftpFileEntry[]>((cb) => sftp.readdir(path, cb)),
      p<string>((cb) => sftp.realpath(path, cb)).catch(() => path)
    ])
    const entries = raw.map((f) => entryFrom(f, resolved)).filter((e): e is SftpEntry => e !== null)
    appLog('sftp', `List directory "${path}" → ${entries.length} entries`)
    return { resolved, entries }
  }

  /** 仅 readdir（测量专用：省去 realpath 往返，取消后在途请求减半） */
  private async listEntries(path: string): Promise<SftpEntry[]> {
    const sftp = await this.ensureChannel()
    const raw = await p<SftpFileEntry[]>((cb) => sftp.readdir(path, cb))
    const entries = raw.map((f) => entryFrom(f, path)).filter((e): e is SftpEntry => e !== null)
    appLog('sftp', `List directory "${path}" → ${entries.length} entries`)
    return entries
  }

  async realpath(path: string): Promise<string> {
    const hit = this.realpathCache.get(path)
    if (hit) return hit
    const sftp = await this.ensureChannel()
    const resolved = await p<string>((cb) => sftp.realpath(path, cb)).catch(() => null)
    if (resolved === null) return path // 通道暂时不可用不缓存，避免固化错误结果
    this.realpathCache.set(path, resolved)
    return resolved
  }

  async readlink(path: string): Promise<string> {
    const sftp = await this.ensureChannel()
    return p<string>((cb) => sftp.readlink(path, cb)).catch(() => '')
  }

  async stat(path: string): Promise<SftpStat> {
    const sftp = await this.ensureChannel()
    const attrs = await p<SftpStats>((cb) => sftp.stat(path, cb))
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
      const attrs = await p<SftpStats>((cb) => sftp.stat(path, cb))
      return (attrs.mode & 0o170000) === 0o040000
    } catch {
      return false
    }
  }

  /* ---------------- 变更操作 ---------------- */

  async mkdir(path: string): Promise<void> {
    const sftp = await this.ensureChannel()
    await p<null>((cb) => sftp.mkdir(path, cb))
  }

  async touch(path: string): Promise<void> {
    const sftp = await this.ensureChannel()
    const handle = await p<Buffer>((cb) => sftp.open(path, 'w', cb))
    await p<null>((cb) => sftp.close(handle, cb))
  }

  async rename(src: string, dest: string): Promise<void> {
    const sftp = await this.ensureChannel()
    await p<null>((cb) => sftp.rename(src, dest, cb))
  }

  async chmod(path: string, mode: number): Promise<void> {
    const sftp = await this.ensureChannel()
    await p<null>((cb) => sftp.chmod(path, mode, cb))
  }

  /* ---------------- 远程编辑（阶段⑤，对照 readForEdit/writeText） ---------------- */

  private static readonly EDIT_MAX_BYTES = 10 * 1024 * 1024

  async readForEdit(
    path: string,
    _knownSize: number,
    encoding: EncodingMode = 'auto'
  ): Promise<SftpEditPayload> {
    const limit = SftpSession.EDIT_MAX_BYTES
    const sftp = await this.ensureChannel()
    const handle = await p<Buffer>((cb) => sftp.open(path, 'r', cb))
    try {
      const chunks: Buffer[] = []
      let offset = 0
      for (;;) {
        const buf = Buffer.alloc(64_000)
        const n = await p<number>((cb) =>
          sftp.read(handle, buf, 0, buf.length, offset, (err, bytesRead) => cb(err, bytesRead))
        )
        if (n <= 0) break
        chunks.push(n === buf.length ? buf : buf.subarray(0, n))
        offset += n
        if (offset > limit) return { kind: 'tooLarge' }
      }
      return { kind: 'text', ...decodeFile(Buffer.concat(chunks), encoding), size: offset }
    } finally {
      await p<null>((cb) => sftp.close(handle, cb)).catch(() => {})
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
    await writeRemoteAtomic(sftp, path, data)
  }

  async unlink(path: string): Promise<void> {
    const sftp = await this.ensureChannel()
    await p<null>((cb) => sftp.unlink(path, cb))
  }

  /** 删除：文件走 unlink；目录走共享连接 exec rm -rf（对照 remove()） */
  async remove(entry: SftpEntry): Promise<void> {
    if (entry.isDir) {
      const client = this.client
      if (!client) throw new Error('host link not active')
      const resolved = await this.realpath(entry.path)
      await execCommand(client, removeDirCommand(resolved))
      return
    }
    await this.unlink(entry.path)
  }

  /* ---------------- 传输（对照 upload/download + SftpTransfer） ---------------- */

  async upload(localPaths: string[], destDir: string): Promise<void> {
    for (const local of localPaths) {
      const xfer = this.beginTransfer(basename(local), 'up', 0)
      const completed = await this.runTransfer(xfer, async (task) => {
        const sftp = await this.transferChannel(task)
        await this.uploadItem(
          local,
          joinPath(destDir, basename(local)),
          xfer,
          task,
          sftp,
          new Set()
        )
      })
      if (!completed) {
        throw new Error(xfer.error ?? `Upload failed: ${basename(local)}`)
      }
    }
  }

  private async uploadItem(
    local: string,
    remote: string,
    xfer: SftpTransferMirror,
    task: TransferTask,
    sftp: SFTPWrapper,
    ancestors: Set<string>
  ): Promise<void> {
    task.signal.throwIfAborted()
    let st: Awaited<ReturnType<typeof fsp.stat>>
    try {
      st = await fsp.stat(local)
    } catch (err) {
      const access = localAccessDeniedError(local, err)
      if (access) {
        xfer.accessDenied = { folder: access.folder, path: access.path }
        throw access
      }
      throw err
    }
    if (st.isDirectory()) {
      const canonical = await fsp.realpath(local)
      if (ancestors.has(canonical))
        throw new Error(`Directory symlink cycle: ${local}`)
      const next = new Set(ancestors).add(canonical)
      try {
        await p((cb) => sftp.mkdir(remote, cb))
      } catch (err) {
        const existing = await p<SftpStats>((cb) => sftp.stat(remote, cb))
        if ((existing.mode & 0o170000) !== 0o040000) throw err
      }
      const kids = await fsp.readdir(local, { withFileTypes: true })
      for (const kid of kids) {
        task.signal.throwIfAborted()
        await this.uploadItem(
          joinLocal(local, kid.name),
          joinPath(remote, kid.name),
          xfer,
          task,
          sftp,
          next
        )
      }
      return
    }
    if (!st.isFile()) throw new Error(`Unsupported file type: ${local}`)
    task.signal.throwIfAborted()
    xfer.total += st.size
    try {
      await pipeline(
        createReadStream(local),
        this.transferMeter(xfer),
        sftp.createWriteStream(remote),
        { signal: task.signal }
      )
    } catch (err) {
      const access = localAccessDeniedError(local, err)
      if (access) {
        xfer.accessDenied = { folder: access.folder, path: access.path }
        throw access
      }
      throw err
    }
  }

  async download(
    entry: SftpEntry,
    destDir?: string,
    opts?: { reveal?: boolean }
  ): Promise<string | undefined> {
    const xfer = this.beginTransfer(entry.name, 'down', entry.size)
    const folder = destDir ?? app.getPath('downloads')
    if (destDir) await fsp.mkdir(destDir, { recursive: true })
    let dest: string | undefined
    const completed = await this.runTransfer(xfer, async (task) => {
      dest = await uniqueLocal(joinLocal(folder, entry.name))
      task.signal.throwIfAborted()
      let owned = false
      try {
        if (entry.isDir) {
          await fsp.mkdir(dest)
          owned = true
          await this.downloadDir(entry, dest, folder, xfer, task)
        } else {
          await this.ensureDiskSpace(folder, entry.size)
          const sftp = await this.transferChannel(task)
          await this.downloadFileTo(entry.path, dest, xfer, task, sftp, () => {
            owned = true
          })
        }
      } catch (err) {
        if (owned) this.queueCleanup(xfer, dest)
        throw err
      }
    })
    if (completed && dest && (opts?.reveal ?? true)) shell.showItemInFolder(dest)
    return completed ? dest : undefined
  }

  /** 目录下载：整个目录 = 一个任务；有 tar 走打包单流，无 tar 回退递归逐文件。先算总量/文件数并预检磁盘，失败清理半成品 */
  private async downloadDir(
    entry: SftpEntry,
    dest: string,
    folder: string,
    xfer: SftpTransferMirror,
    task: TransferTask
  ): Promise<void> {
    const client = this.client
    if (!client) throw new Error('host link not active')
    const hasTar = (await this.taskExec(task, 'command -v tar')).trim() !== ''
    try {
      if (hasTar) {
        const total = await this.dirSize(entry.path, task)
        await this.ensureDiskSpace(folder, total * 2)
        xfer.total = total
        task.signal.throwIfAborted()
        await this.downloadDirViaTar(entry, dest, xfer, client, task)
      } else {
        const sftp = await this.transferChannel(task)
        const count = await this.countDir(entry.path, task, sftp)
        await this.ensureDiskSpace(folder, count.bytes)
        xfer.total = count.bytes
        xfer.totalFiles = count.files
        xfer.files = 0
        await this.downloadDirRecursive(entry.path, dest, xfer, task, sftp)
      }
    } catch (err) {
      // 失败（含磁盘空间不足/中途写满）清理半成品目录
      this.queueCleanup(xfer, dest)
      throw err
    }
  }

  /** 目录总字节数（du -sb，纯 tar 不压缩时近似总量）；失败返回 0（退化为不定态） */
  private async dirSize(path: string, task: TransferTask): Promise<number> {
    const client = this.client
    if (!client) return 0
    try {
      const out = await this.taskExec(task, `du -sb ${shellQuote(path)}`)
      const n = parseInt(out.trim().split(/\s+/)[0] ?? '', 10)
      return Number.isFinite(n) && n > 0 ? n : 0
    } catch {
      return 0
    }
  }

  /** 递归统计文件数与总字节（兜底下载的进度与磁盘预检用） */
  private async countDir(
    remote: string,
    task: TransferTask,
    sftp: SFTPWrapper
  ): Promise<{ files: number; bytes: number }> {
    task.signal.throwIfAborted()
    const kids = await this.transferEntries(remote, task, sftp)
    let files = 0
    let bytes = 0
    for (const kid of kids) {
      if (kid.isDir) {
        const sub = await this.countDir(kid.path, task, sftp)
        files += sub.files
        bytes += sub.bytes
      } else {
        files += 1
        bytes += kid.size
      }
    }
    return { files, bytes }
  }

  /** 磁盘空间预检：预期总大小超过本地可用空间则抛错 */
  private async ensureDiskSpace(folder: string, total: number): Promise<void> {
    if (total <= 0) return
    const st = await fsp.statfs(folder)
    const avail = st.bavail * st.bsize
    if (total > avail) throw new Error('Insufficient disk space')
  }

  /** 纯 tar（不压缩）：-C <dir> . 打包目录内容，经共享连接 exec 流式解包到 dest */
  private async downloadDirViaTar(
    entry: SftpEntry,
    dest: string,
    xfer: SftpTransferMirror,
    client: Client,
    task: TransferTask
  ): Promise<void> {
    const staging = await fsp.mkdtemp(joinLocal(app.getPath('downloads'), '.ggterm-'))
    this.queueCleanup(xfer, staging)
    const archive = joinLocal(staging, 'download.tar')
    const contents = joinLocal(staging, 'contents')
    await fsp.mkdir(contents)
    task.signal.throwIfAborted()
    const stream = await task.opening(
      p<import('ssh2').ClientChannel>((cb) =>
        client.exec(`tar cf - -C ${shellQuote(entry.path)} .`, cb)
      ),
      (s) => {
        try {
          s.signal('TERM')
        } catch {
          /* The remote may already have closed the command channel. */
        }
        s.destroy()
      }
    )
    let diagnostic = ''
    stream.stderr.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(-4096)
    })
    const exited = task.opening(
      new Promise<void>((resolve, reject) => {
        stream.once('close', (code: number | null) =>
          code === 0 ? resolve() : reject(new Error(diagnostic || `tar exited: ${code}`))
        )
        stream.once('error', reject)
      }),
      () => {}
    )
    xfer.phase = 'downloading'
    const receiving = receiveArchive(stream, archive, task, (bytes) =>
      this.tickTransfer(xfer, bytes)
    )
    try {
      await Promise.all([receiving, exited])
    } catch (error) {
      if (!task.signal.aborted) xfer.error = errorMessage(error)
      task.cancel()
      await receiving.catch(() => {})
      throw error
    }
    task.signal.throwIfAborted()
    xfer.phase = 'extracting'
    xfer.speed = 0
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
    await this.ensureDiskSpace(app.getPath('downloads'), xfer.total)
    await extractArchive(archive, contents, task)
    task.signal.throwIfAborted()
    await fsp.rmdir(dest)
    task.signal.throwIfAborted()
    await fsp.rename(contents, dest)
    task.signal.throwIfAborted()
  }

  /** 兜底：远端无 tar 时递归逐文件下载，字节累计进同一任务 */
  private async downloadDirRecursive(
    remote: string,
    local: string,
    xfer: SftpTransferMirror,
    task: TransferTask,
    sftp: SFTPWrapper
  ): Promise<void> {
    const kids = await this.transferEntries(remote, task, sftp)
    for (const kid of kids) {
      task.signal.throwIfAborted()
      const dest = joinLocal(local, kid.name)
      if (kid.isDir) {
        await fsp.mkdir(dest, { recursive: true })
        await this.downloadDirRecursive(kid.path, dest, xfer, task, sftp)
      } else {
        await this.downloadFileTo(kid.path, dest, xfer, task, sftp)
        xfer.files = (xfer.files ?? 0) + 1
        this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
      }
    }
  }

  /** 逐文件落盘，进度累计进父任务（目录兜底下载用；base = 已下载字节） */
  private async downloadFileTo(
    remote: string,
    local: string,
    xfer: SftpTransferMirror,
    task: TransferTask,
    sftp: SFTPWrapper,
    onCreated?: () => void
  ): Promise<void> {
    task.signal.throwIfAborted()
    const output = createWriteStream(local, { flags: 'wx' })
    output.once('open', () => onCreated?.())
    await pipeline(this.downloadChunks(remote, task, sftp), this.transferMeter(xfer), output, {
      signal: task.signal
    })
  }

  /** Avoid ssh2 ReadStream._destroy waiting forever for OPEN/CLOSE after channel abort. */
  private async *downloadChunks(
    remote: string,
    task: TransferTask,
    sftp: SFTPWrapper
  ): AsyncGenerator<Buffer> {
    const handle = await task.opening(
      p<Buffer>((cb) => sftp.open(remote, 'r', cb)),
      () => {}
    )
    try {
      let position = 0
      while (true) {
        task.signal.throwIfAborted()
        const buffer = Buffer.allocUnsafe(64 * 1024)
        const bytes = await task.opening(
          new Promise<number>((resolve, reject) => {
            sftp.read(handle, buffer, 0, buffer.length, position, (err, bytesRead) => {
              if (err) reject(err)
              else resolve(bytesRead)
            })
          }),
          () => {}
        )
        if (bytes === 0) break
        position += bytes
        yield buffer.subarray(0, bytes)
      }
    } finally {
      // Aborted tasks already destroy their dedicated SFTP channel (and its handles).
      if (!task.signal.aborted) {
        await task.opening(
          p<void>((cb) => sftp.close(handle, cb)),
          () => {}
        )
      }
    }
  }

  private async runTransfer(
    xfer: SftpTransferMirror,
    work: (task: TransferTask) => Promise<void>
  ): Promise<boolean> {
    const task = this.tasks.get(xfer.id)!
    try {
      await work(task)
      task.signal.throwIfAborted()
      this.endTransfer(xfer, 'done')
      return true
    } catch (err) {
      this.endTransfer(
        xfer,
        task.signal.aborted && !xfer.error ? 'canceled' : 'error',
        task.signal.aborted && !xfer.error ? undefined : errorMessage(err)
      )
      return false
    } finally {
      task.dispose()
      this.tasks.delete(xfer.id)
      await this.retryCleanup(xfer.id)
    }
  }

  private async transferChannel(task: TransferTask): Promise<SFTPWrapper> {
    task.signal.throwIfAborted()
    const client = this.client
    if (!client) throw new Error('host link not active')
    return task.opening(
      p<SFTPWrapper>((cb) => client.sftp(cb)),
      (sftp) => sftp.destroy()
    )
  }

  private async transferEntries(
    path: string,
    task: TransferTask,
    sftp: SFTPWrapper
  ): Promise<SftpEntry[]> {
    task.signal.throwIfAborted()
    const raw = await task.opening(
      p<SftpFileEntry[]>((cb) => sftp.readdir(path, cb)),
      () => {}
    )
    return raw
      .map((entry) => entryFrom(entry, path))
      .filter((entry): entry is SftpEntry => entry !== null)
  }

  private async taskExec(task: TransferTask, command: string): Promise<string> {
    task.signal.throwIfAborted()
    const client = this.client
    if (!client) throw new Error('host link not active')
    const stream = await task.opening(
      p<import('ssh2').ClientChannel>((cb) => client.exec(command, cb)),
      (s) => s.destroy()
    )
    return task.opening(
      new Promise<string>((resolve, reject) => {
        let output = ''
        stream.on('data', (data: Buffer) => {
          if (output.length < 65536) output += data.toString()
        })
        stream.stderr.resume()
        stream.once('close', () => resolve(output))
        stream.once('error', reject)
      }),
      () => {}
    )
  }

  private transferMeter(xfer: SftpTransferMirror): Transform {
    let bytes = xfer.bytes
    return new Transform({
      transform: (chunk: Buffer, _encoding, cb) => {
        bytes += chunk.length
        this.tickTransfer(xfer, bytes)
        cb(null, chunk)
      }
    })
  }

  /* ---------------- 传输镜像（对照 SftpTransfer + enqueue） ---------------- */

  private beginTransfer(
    name: string,
    direction: 'up' | 'down',
    total: number,
    totalFiles?: number
  ): SftpTransferMirror {
    const xfer: SftpTransferMirror = {
      id: crypto.randomUUID(),
      name,
      direction,
      status: 'running',
      bytes: 0,
      total,
      ...(totalFiles !== undefined ? { files: 0, totalFiles } : {})
    }
    this.tasks.set(xfer.id, new TransferTask())
    this.transfers = [
      xfer,
      ...this.transfers.filter((t) => t.status === 'running' || this.cleanupPaths.has(t.id)),
      ...this.transfers
        .filter((t) => t.status !== 'running' && !this.cleanupPaths.has(t.id))
        .slice(0, 23)
    ]
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
    appLog('sftp', `${direction === 'up' ? 'Upload' : 'Download'} "${name}" started`)
    return xfer
  }

  private tickTransfer(xfer: SftpTransferMirror, transferred: number): void {
    if (this.tasks.get(xfer.id)?.signal.aborted) return
    const prev = this.tickAt.get(xfer.id)
    const now = Date.now()
    // 瞬时速度：连续采样差值（每 tick 都更新基准，不因节流丢精度）
    if (prev && now > prev.at && transferred >= prev.bytes) {
      xfer.speed = Math.round(((transferred - prev.bytes) * 1000) / (now - prev.at))
    }
    xfer.bytes = transferred
    this.tickAt.set(xfer.id, { at: now, bytes: transferred })
    // step 回调每 chunk(32KB) 一次，不节流会 IPC 洪泛；最终值由 endTransfer 兜底
    if (now - (this.lastEmitAt.get(xfer.id) ?? 0) < 100) return
    this.lastEmitAt.set(xfer.id, now)
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
  }

  private endTransfer(
    xfer: SftpTransferMirror,
    status: 'done' | 'error' | 'canceled',
    error?: string
  ): void {
    xfer.status = status
    if (error) xfer.error = error
    this.tickAt.delete(xfer.id)
    this.lastEmitAt.delete(xfer.id)
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
    // 三点式日志：仅 开始/完成/失败/取消（不带耗时/速率），进度 tick 不记录
    const label = xfer.direction === 'up' ? 'Upload' : 'Download'
    if (status === 'done') {
      appLog('sftp', `${label} "${xfer.name}" completed`)
    } else if (status === 'canceled') {
      appLog('sftp', `${label} "${xfer.name}" canceled`)
    } else {
      appLog('sftp', `${label} "${xfer.name}" failed: ${error ?? 'unknown error'}`, 'error')
    }
  }

  /** Abort streams and the task's dedicated channel; report canceled after the operation unwinds. */
  cancelTransfer(transferId: string): void {
    const task = this.tasks.get(transferId)
    const xfer = this.transfers.find((item) => item.id === transferId)
    if (!task || !xfer || xfer.status !== 'running' || xfer.cancelRequested) return
    xfer.cancelRequested = true
    xfer.speed = 0
    task.cancel()
    this.events.onSftpTransfer({ hostId: this.link.hostId, transfer: { ...xfer } })
  }

  /* ---------------- 目录测量（对照 measureDirectory，120ms 节流 + 可取消） ---------------- */

  async measure(path: string): Promise<void> {
    this.abortMeasure()
    const abort = new AbortController()
    this.measureAbort = abort
    const hostId = this.link.hostId
    let last = 0
    const acc = { bytes: 0, files: 0, dirs: 0, skipped: 0, skippedPaths: [] as string[] }
    const emit = (done: boolean, error?: string): void => {
      this.events.onSftpMeasure({ hostId, path, ...acc, done, error })
    }
    try {
      await this.accumulate(path, acc, abort.signal, () => {
        const now = Date.now()
        if (now - last >= 120) {
          last = now
          emit(false)
        }
      })
      emit(true)
    } catch (err) {
      if (abort.signal.aborted) return
      appLog('sftp', `Measure "${path}" failed: ${errorMessage(err)}`, 'error')
      emit(true, errorMessage(err))
    }
  }

  /**
   * 目录测量（对照 measureDirectory，120ms 节流 + 可取消）。
   * 并发遍历：任务队列 + 32 个 worker（SFTP 单通道支持多请求在途）。
   * 错误语义对齐 du：根目录不可读 → 整体失败；子目录不可读（如 root
   * 属主的 0700 目录）→ 计入 skipped 并继续测量其余部分。
   */
  private static readonly MEASURE_CONCURRENCY = 32

  private async accumulate(
    root: string,
    acc: { bytes: number; files: number; dirs: number; skipped: number; skippedPaths: string[] },
    signal: AbortSignal,
    progress: () => void
  ): Promise<void> {
    const queue: string[] = [root]
    this.measureQueue = queue
    let failed = false
    const worker = async (): Promise<void> => {
      while (!failed && queue.length > 0) {
        if (signal.aborted) throw new Error('aborted')
        const dir = queue.shift()
        if (dir === undefined) break
        let kids: SftpEntry[]
        try {
          kids = await this.listEntries(dir)
        } catch (err) {
          if (signal.aborted) throw new Error('aborted')
          if (dir === root) throw err
          acc.skipped += 1
          if (acc.skippedPaths.length < 5) acc.skippedPaths.push(dir.split('/').pop() || dir)
          appLog('sftp', `Measure skipped unreadable directory "${dir}": ${errorMessage(err)}`, 'error')
          progress()
          continue
        }
        for (const kid of kids) {
          if (signal.aborted) throw new Error('aborted')
          if (kid.isDir) {
            acc.dirs += 1
            queue.push(kid.path)
          } else {
            acc.files += 1
            acc.bytes += kid.size
          }
          progress()
        }
      }
    }
    try {
      const workers = Array.from({ length: SftpSession.MEASURE_CONCURRENCY }, () =>
        worker().catch((err: unknown) => {
          failed = true // 首个失败清场：其余 worker 快速退出，错误向上冒泡
          queue.length = 0
          throw err
        })
      )
      await Promise.all(workers)
    } finally {
      if (this.measureQueue === queue) this.measureQueue = null
    }
  }

  abortMeasure(): void {
    this.measureAbort?.abort()
    this.measureAbort = null
    // 硬止损：清空任务队列，所有 worker 在当前在途 readdir 返回后立即退出，
    // 不再发起新请求（ssh2 无按请求取消 API，在途 ≤ 并发数且只含 readdir）
    if (this.measureQueue !== null) {
      this.measureQueue.length = 0
      this.measureQueue = null
      appLog('sftp', 'Directory measurement canceled')
    }
  }
}

/** 本地选件（对照 pickUploadFiles/Folders；与具体会话无关） */
export async function pickLocalPaths(
  folders: boolean,
  parent?: Electron.BrowserWindow
): Promise<string[]> {
  const properties: Electron.OpenDialogOptions['properties'] = folders
    ? ['openDirectory', 'multiSelections']
    : ['openFile', 'multiSelections']
  const res = parent
    ? await dialog.showOpenDialog(parent, { properties })
    : await dialog.showOpenDialog({ properties })
  if (res.canceled) return []
  return res.filePaths
}

/** ssh2 FileEntry → SftpEntry（对照 SftpController.entry） */
function entryFrom(f: SftpFileEntry, dir: string): SftpEntry | null {
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

/** 下载目标重名自动加 "(n)"（对照 SftpController.unique） */
async function uniqueLocal(dest: string): Promise<string> {
  let candidate = dest
  let i = 1
  for (;;) {
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
    const { dir, name, ext } = parse(candidate)
    candidate = joinLocal(dir, `${name} (${i})${ext}`)
    i += 1
  }
}
