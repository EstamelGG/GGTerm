import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'

function call<T>(
  action: (cb: (err: Error | undefined | null, result?: T) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) =>
    action((err, result) => (err ? reject(err) : resolve(result as T)))
  )
}

function unsupported(err: unknown): boolean {
  return (err as { code?: number })?.code === 8 || /unsupported|not support/i.test(String(err))
}

/** SSH_FX_NO_SUCH_FILE = 2；消息兜底兼容非标准服务器 */
function isNoEnt(err: unknown): boolean {
  return (err as { code?: number })?.code === 2 || /no such file/i.test(String(err))
}

/** Never unlink/truncate the original. Servers without overwrite support fail safely. */
export async function writeRemoteAtomic(
  sftp: SFTPWrapper,
  path: string,
  data: Buffer
): Promise<void> {
  // 目标存在 → 继承其 uid/gid/mode（编辑场景）；不存在（ENOENT）→ 新建文件，用默认 0644。
  // 父目录不存在时 open 会如实抛 "No such file"（不做隐式 mkdir，避免路径拼写错误被静默吞掉）。
  let target = path
  let attrs: Stats | undefined
  try {
    target = await call<string>((cb) => sftp.realpath(path, cb))
    attrs = await call<Stats>((cb) => sftp.stat(target, cb))
  } catch (err) {
    if (!isNoEnt(err)) throw err
  }
  const temp = posix.join(posix.dirname(target), `.ggterm-${randomUUID()}.tmp`)
  let handle: Buffer | undefined
  let created = false
  try {
    handle = await call<Buffer>((cb) => sftp.open(temp, 'wx', { mode: attrs ? 0o600 : 0o644 }, cb))
    created = true
    await call((cb) => sftp.write(handle!, data, 0, data.length, 0, cb))
    if (attrs) {
      const tempAttrs = await call<Stats>((cb) => sftp.fstat(handle!, cb))
      if (tempAttrs.uid !== attrs.uid || tempAttrs.gid !== attrs.gid) {
        await call((cb) => sftp.fchown(handle!, attrs.uid, attrs.gid, cb))
      }
      await call((cb) => sftp.fchmod(handle!, attrs.mode & 0o7777, cb))
    }
    try {
      await call((cb) => sftp.ext_openssh_fsync(handle!, cb))
    } catch (err) {
      if (!unsupported(err)) throw err
    }
    await call((cb) => sftp.close(handle!, cb))
    handle = undefined
    try {
      await call((cb) => sftp.ext_openssh_rename(temp, target, cb))
    } catch (err) {
      if (!unsupported(err)) throw err
      // SFTP v3 rename may reject an existing target. Do not fall back to deleting it.
      await call((cb) => sftp.rename(temp, target, cb))
    }
    created = false
  } finally {
    if (handle) await call((cb) => sftp.close(handle!, cb)).catch(() => {})
    if (created) await call((cb) => sftp.unlink(temp, cb)).catch(() => {})
  }
}
