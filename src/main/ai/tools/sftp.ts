import { basename } from 'node:path'
import { z } from 'zod'
import { defineTool } from './shared'
import type { SftpEntry } from '../../../shared/types'
import { hostIdSchema, intentSchema, sftpOf, type AnyTool } from './shared'

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
    description: 'Read a remote text file (via SFTP; preferred over cat; errors above 10MB).',
    parameters: z.object({ description: intentSchema, hostId: hostIdSchema, path: z.string() }),
    handler: async ({ hostId, path }) => {
      const res = await (await sftpOf(hostId)).readForEdit(path, 0)
      if (res.kind === 'tooLarge') throw new Error('File too large (>10MB); use a command instead')
      return { path, content: res.text, size: res.size }
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
      'Edit part of a remote text file precisely (anchor replacement): oldText is copied verbatim from sftp_read output (indentation included), newText is the replacement (empty string = delete the snippet). By default oldText must appear EXACTLY ONCE; if it appears multiple times (common in XML/JSON with repeated keys), pass occurrence (1-based) to replace the Nth match. Zero matches abort. Best for localized edits of large files; use sftp_write to create files or rewrite whole content.',
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
      if (oldText === newText) throw new Error('oldText equals newText; nothing to change')
      const sftp = await sftpOf(hostId)
      const before = await sftp.stat(path)
      const res = await sftp.readForEdit(path, 0)
      if (res.kind === 'tooLarge') throw new Error('File too large (>10MB); use a command instead')
      if (res.binary) throw new Error('Binary file; use a command instead')
      if (res.lossy)
        throw new Error('File encoding cannot be round-tripped losslessly; use a command instead')
      const content = res.text
      // 匹配索引（与计数一致：逐字符前进，保守计重叠）
      const indicesOf = (needle: string): number[] => {
        const idx: number[] = []
        for (let i = content.indexOf(needle); i !== -1; i = content.indexOf(needle, i + 1))
          idx.push(i)
        return idx
      }
      // CRLF 容错：agent 锚点通常带 \n；CRLF 文件先按原样找，找不到再试 \r\n 归一
      let anchor = oldText
      let patch = newText
      let indices = indicesOf(anchor)
      if (indices.length === 0 && content.includes('\r\n') && oldText.includes('\n')) {
        const crlfOld = oldText.replace(/\n/g, '\r\n')
        const crlfIdx = indicesOf(crlfOld)
        if (crlfIdx.length > 0) {
          anchor = crlfOld
          patch = newText.replace(/\n/g, '\r\n')
          indices = crlfIdx
        }
      }
      if (indices.length === 0)
        throw new Error('oldText not found in the file (0 matches); run sftp_read to verify first')
      let index: number
      if (occurrence != null) {
        if (occurrence > indices.length)
          throw new Error(
            `oldText matched ${indices.length} place(s); occurrence ${occurrence} is out of range`
          )
        index = indices[occurrence - 1]
      } else {
        if (indices.length > 1)
          throw new Error(
            `oldText matched ${indices.length} places; use a longer snippet or the occurrence parameter to pick one`
          )
        index = indices[0]
      }
      // 并发防护：读改之间若文件被他人改动（mtime/size 变化）则拒绝，避免覆盖别人的更新
      const after = await sftp.stat(path)
      if (after.modified !== before.modified || after.size !== before.size)
        throw new Error('File changed on the server during edit; re-run sftp_read and retry')
      const next = content.slice(0, index) + patch + content.slice(index + anchor.length)
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
