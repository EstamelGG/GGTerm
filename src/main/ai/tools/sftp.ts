import { basename } from 'node:path'
import { z } from 'zod'
import { defineTool } from './shared'
import type { SftpEntry } from '../../../shared/types'
import { applyAnchorPatch } from './anchorPatch'
import { pageHint, pageLines, READ_DEFAULT_LINES } from './page'
import { hostIdSchema, intentSchema, sftpOf, type AnyTool } from './shared'

/** sftp_read / sftp_patch 的读取上限（与 SftpSession.EDIT_MAX_BYTES 一致）：超过只能改用远端命令按需读 */
const SFTP_READ_MAX_BYTES = 10 * 1024 * 1024

const isDirPermissions = (permissions: number | null): boolean =>
  permissions !== null && (permissions & 0o170000) === 0o040000

/**
 * 超限错误：明确「不要重试」并给出可执行的替代命令 ——
 * 否则模型容易反复换路径重试，或干脆去下载整个大文件。
 */
function tooLargeForSftpRead(path: string, size: number | null): Error {
  const actual = size === null ? 'over 10MB' : `${(size / 1024 / 1024).toFixed(1)}MB`
  return new Error(
    `File is too large for sftp_read (${actual}; limit 10MB). Do not retry it here — read only the part you need on the host with execute: ` +
      `head -n 200 ${path}, tail -n 200 ${path}, sed -n '100,300p' ${path}, grep -n <pattern> ${path}`
  )
}

/** 删除条目构造（目录走 rm -rf，文件走 unlink） */
async function removePath(hostId: string, path: string): Promise<void> {
  const sftp = await sftpOf(hostId)
  if (await sftp.isDirectory(path)) {
    const st = await sftp.stat(path)
    const entry: SftpEntry = {
      name: basename(path),
      path,
      isDir: true,
      isLink: false,
      size: st.size,
      permissions: st.permissions,
      uid: st.uid,
      gid: st.gid,
      accessed: st.accessed,
      modified: st.modified,
      longname: '',
      linkTarget: null
    }
    await sftp.remove(entry)
    return
  }
  await sftp.unlink(path)
}

/** SFTP 文件域：读/写/删/建/改名/列目录 */
export const sftpTools: AnyTool[] = [
  defineTool('sftp_list', {
    description:
      'List remote directory contents (via SFTP; preferred over the ls command). Each item carries name/path/isDir (true for directories)/size (bytes; block size for directories)/isLink (true for symlinks) — file sizes and types are already in the result, so no ls/stat commands are needed.',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema, path: z.string() }),
    handler: async ({ hostId, path }) => {
      const { entries } = await (await sftpOf(hostId)).list(path)
      return entries.map((e) => ({
        name: e.name,
        path: e.path,
        isDir: e.isDir,
        size: e.size,
        isLink: e.isLink
      }))
    }
  }),
  defineTool('sftp_read', {
    description: `Read a remote text file (via SFTP; preferred over cat). Only files up to 10MB: larger ones are refused before any transfer — read those on the host with execute (head/tail/sed/grep) instead of retrying. Returns a window of complete lines — ${READ_DEFAULT_LINES} lines by default, capped by size as well — instead of the whole file: the result carries totalLines and, when it was cut short, nextOffset, which you pass back as offset to continue reading. Content is verbatim (CRLF preserved), so a returned window can be used directly as sftp_patch anchors.`,
    parameters: z.object({
      description: intentSchema,
      hostId: hostIdSchema,
      path: z.string(),
      offset: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('First line to return, 1-based; default 1'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum lines to return; default ${READ_DEFAULT_LINES}`)
    }),
    handler: async ({ hostId, path, offset, limit }) => {
      const sftp = await sftpOf(hostId)
      // 先 stat 判大小：超限直接拒绝，不为一页内容把整个大文件拖下来
      const st = await sftp.stat(path)
      if (isDirPermissions(st.permissions))
        throw new Error('Path is a directory; use sftp_list instead')
      if (st.size > SFTP_READ_MAX_BYTES) throw tooLargeForSftpRead(path, st.size)
      const res = await sftp.readForEdit(path, 0)
      // stat 与读取之间文件可能变大：保留兜底
      if (res.kind === 'tooLarge') throw tooLargeForSftpRead(path, null)
      const page = pageLines(res.text, offset ?? 1, limit ?? READ_DEFAULT_LINES)
      const hint = pageHint(page)
      return {
        path,
        content: page.content,
        size: res.size,
        totalLines: page.totalLines,
        fromLine: page.fromLine,
        toLine: page.toLine,
        truncated: page.truncated,
        ...(page.nextOffset ? { nextOffset: page.nextOffset } : {}),
        ...(page.longLines.length ? { longLines: page.longLines } : {}),
        ...(hint ? { hint } : {})
      }
    }
  }),
  defineTool('sftp_stat', {
    description:
      'Get remote file/directory metadata (size, permissions, uid/gid, access/modify times, isDir) without reading content. Use to check existence, size or type of a single path without listing its parent directory; throws if the path does not exist.',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema, path: z.string() }),
    handler: async ({ hostId, path }) => {
      const st = await (await sftpOf(hostId)).stat(path)
      const isDir = st.permissions !== null && (st.permissions & 0o170000) === 0o040000
      return {
        path,
        isDir,
        size: st.size,
        permissions: st.permissions,
        uid: st.uid,
        gid: st.gid,
        accessed: st.accessed,
        modified: st.modified
      }
    }
  }),
  defineTool('sftp_write', {
    description:
      'Write a remote text file (overwrites; creates the file automatically if missing — the parent directory must already exist).',
    parameters: z.object({
      description: intentSchema,
      hostId: hostIdSchema,
      path: z.string(),
      content: z.string()
    }),
    handler: async ({ hostId, path, content }) => {
      await (await sftpOf(hostId)).writeText(path, content)
      return { path, written: Buffer.byteLength(content, 'utf8') }
    }
  }),
  defineTool('sftp_patch', {
    description:
      'Edit part of a remote text file precisely (anchor replacement): oldText is copied verbatim from sftp_read output (indentation included), newText is the replacement (empty string = delete the snippet). By default oldText must appear EXACTLY ONCE; if it appears multiple times (common in XML/JSON with repeated keys), pass occurrence (1-based) to replace the Nth match. Zero matches abort. Best for localized edits; files above 10MB are refused — edit those on the host with execute. Use sftp_write to create files or rewrite whole content.',
    parameters: z.object({
      description: intentSchema,
      hostId: hostIdSchema,
      path: z.string(),
      oldText: z
        .string()
        .min(1)
        .describe('Original snippet to replace (anchor; copy verbatim from sftp_read output)'),
      newText: z.string().describe('Replacement content; empty string = delete the snippet'),
      occurrence: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          '1-based index of which match to replace when oldText appears multiple times; omit to require a unique match'
        )
    }),
    handler: async ({ hostId, path, oldText, newText, occurrence }) => {
      const sftp = await sftpOf(hostId)
      const before = await sftp.stat(path)
      // 超限不读：patch 必须拿到全文，10MB 以上只能改用远端命令就地改
      if (before.size > SFTP_READ_MAX_BYTES)
        throw new Error(
          `File is too large to edit through sftp_patch (${(before.size / 1024 / 1024).toFixed(1)}MB; limit 10MB). Edit it on the host with execute (e.g. sed -i) instead.`
        )
      const res = await sftp.readForEdit(path, 0)
      if (res.kind === 'tooLarge')
        throw new Error(
          'File is too large for sftp_patch (over 10MB); edit it on the host with execute instead'
        )
      if (res.binary) throw new Error('Binary file; use a command instead')
      if (res.lossy)
        throw new Error('File encoding cannot be round-tripped losslessly; use a command instead')
      const { next, anchor, patch } = applyAnchorPatch(
        res.text,
        oldText,
        newText,
        occurrence,
        'sftp_read'
      )
      // 并发防护：读改之间若文件被他人改动（mtime/size 变化）则拒绝，避免覆盖别人的更新
      const after = await sftp.stat(path)
      if (after.modified !== before.modified || after.size !== before.size)
        throw new Error('File changed on the server during edit; re-run sftp_read and retry')
      await sftp.writeText(path, next, res.encoding, res.bom)
      return {
        path,
        replaced: 1,
        size: res.size - Buffer.byteLength(anchor) + Buffer.byteLength(patch)
      }
    }
  }),
  defineTool('sftp_delete', {
    description:
      'Delete a remote file or directory (directories recursively). Prefer this tool over rm/rmdir commands: it bypasses the shell (no injection risk) and goes through unified approval.',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema, path: z.string() }),
    handler: async ({ hostId, path }) => {
      await removePath(hostId, path)
      return { path, deleted: true }
    }
  }),
  defineTool('sftp_mkdir', {
    description: 'Create a remote directory.',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema, path: z.string() }),
    handler: async ({ hostId, path }) => {
      await (await sftpOf(hostId)).mkdir(path)
      return { path, created: true }
    }
  }),
  defineTool('sftp_rename', {
    description: 'Rename or move a remote file/directory.',
    parameters: z.object({
      description: intentSchema,
      hostId: hostIdSchema,
      src: z.string(),
      dest: z.string()
    }),
    handler: async ({ hostId, src, dest }) => {
      await (await sftpOf(hostId)).rename(src, dest)
      return { src, dest, renamed: true }
    }
  })
]
