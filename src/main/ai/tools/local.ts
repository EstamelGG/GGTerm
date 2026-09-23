import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import iconv from 'iconv-lite'
import { z } from 'zod'
import { stripAnsi } from '../../ssh/shellBuffer'
import { decodeFile, encodeFile } from '../../ssh/textEncoding'
import { localAccessDeniedError } from '../../localAccess'
import type { FileEncoding } from '../../../shared/encoding'
import { applyAnchorPatch } from './anchorPatch'
import { pageHint, pageLines, READ_DEFAULT_LINES } from './page'
import { defineTool, intentSchema, type AnyTool } from './shared'

/**
 * 本机域：本地文件读写/检索 + 本地一次性命令执行（三个平台通用）。
 *
 * 与远端（sftp_* / execute）的分工：
 * - 本地是「一次性」语义：local_exec 跑完即返回，没有后台 shell、没有查看器、不能交互（stdin 关闭，
 *   需要输入的命令直接拿到 EOF 而不是挂住）；持久/交互式场景走 execute 的远端后台 shell。
 * - 路径统一展开 `~`、相对路径按家目录解析（agent 没有本地 cwd 概念），一律返回绝对路径。
 * - macOS 受保护目录（Downloads/Documents/Desktop）命中 TCC 时换成可操作文案（引导去系统设置授权）；
 *   非 macOS 上 localAccessDeniedError 恒为 null，出错信息原样回传。
 *
 * 平台差异集中在三处：shell 选择（shellInvocation）、杀进程树（killTree）、输出解码（decodeOutput）。
 */

const isWindows = process.platform === 'win32'

/** 单文件读取上限（与远端 sftp_read 的 10MB 对齐） */
const MAX_READ_BYTES = 10 * 1024 * 1024
/** 命令输出捕获上限（原始字节）：超过后只保留头尾，中间省略（避免一次命令把上下文顶爆） */
const EXEC_CAPTURE_BYTES = 4 * 1024 * 1024
const EXEC_OUTPUT_CHARS = 24 * 1024
const EXEC_OUTPUT_HALF = 12 * 1024
const EXEC_DEFAULT_TIMEOUT_MS = 60_000
const EXEC_MAX_TIMEOUT_MS = 600_000
/** grep 遍历上限：文件数 / 单文件大小 / 累计扫描量，防止在大目录上跑飞 */
const GREP_MAX_FILES = 2000
const GREP_MAX_FILE_BYTES = 512 * 1024
const GREP_MAX_SCANNED_BYTES = 32 * 1024 * 1024
const GREP_MAX_DEPTH = 12

/** local_exec / 系统提示里对 shell 的描述（随平台变化，供文档字符串引用） */
const SHELL_DOC = isWindows
  ? 'Windows PowerShell (-NoProfile -NonInteractive, falling back to %ComSpec% / cmd.exe)'
  : 'a login shell ($SHELL -lc, so PATH from .zprofile/.profile is loaded)'

/**
 * 本机命令的 shell：命令始终作为单个 argv 传入，不经我们拼接（避免注入面）。
 * - POSIX：用户登录 shell -lc；SHELL 缺失时退回 /bin/sh。
 * - Windows：优先 Windows PowerShell（-NoProfile -NonInteractive，不加载用户脚本、不进入交互提示），
 *   系统里没有则退回 %ComSpec% / cmd.exe（/d 跳过 AutoRun、/s /c 执行并退出）。
 */
function shellInvocation(command: string): { file: string; args: string[] } {
  if (!isWindows) return { file: process.env.SHELL || '/bin/sh', args: ['-lc', command] }
  const root = process.env.SystemRoot
  const powershell = root
    ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : ''
  if (powershell && existsSync(powershell))
    return { file: powershell, args: ['-NoProfile', '-NonInteractive', '-Command', command] }
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
}

/** `~` 展开（接受 ~/ 与 ~\）+ 相对路径按家目录解析；返回绝对路径 */
function localPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('path is required')
  const expanded =
    trimmed === '~' || /^~[\\/]/.test(trimmed) ? join(homedir(), trimmed.slice(1)) : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded)
}

/** 文件系统调用：EPERM/EACCES 落在受保护目录时换成引导授权的文案，其余原样抛出 */
async function fsCall<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw localAccessDeniedError(path, err) ?? err
  }
}

/**
 * 读本地文本文件：目录 / 超大 / 二进制一律给出可操作的替代路径。
 * 编码自动识别（UTF-8/BOM、UTF-16、GB18030/GBK、Big5…）—— Windows 上的中文文本多数不是 UTF-8，
 * 直接按 UTF-8 解会得到乱码，且写回时会毁掉原文件。
 */
async function readText(path: string): Promise<{
  text: string
  size: number
  encoding: FileEncoding
  bom: boolean
  lossy: boolean
}> {
  const st = await fsCall(path, () => stat(path))
  if (st.isDirectory()) throw new Error('Path is a directory; use local_list instead')
  if (!st.isFile()) throw new Error('Not a regular file (device/socket/fifo?); nothing to read')
  if (st.size > MAX_READ_BYTES)
    throw new Error('File too large (>10MB); read only the part you need with local_exec instead')
  const buf = await fsCall(path, () => readFile(path))
  const dec = decodeFile(buf)
  if (dec.binary) throw new Error('Binary file; inspect it with local_exec instead')
  return {
    text: dec.text,
    size: st.size,
    encoding: dec.encoding,
    bom: dec.bom,
    lossy: dec.lossy
  }
}

/** 命令输出清洗：去 ANSI、CRLF 归一（Windows 输出是 \r\n）、折叠 \r 进度行（保留 \r 之后的最终态） */
function cleanOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n')
}

/** Windows 控制台代码页（OEM）兜底 codec；只探测一次，避免每次执行都多起一个进程 */
let winCodePage: string | null | undefined

function windowsCodePage(): string | null {
  if (winCodePage !== undefined) return winCodePage
  winCodePage = null
  try {
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'chcp'], {
      encoding: 'latin1',
      windowsHide: true
    })
    const cp = /(\d{3,5})/.exec(out)?.[1]
    // 65001 本身就是 UTF-8，无需兜底；其余交 cp<页号> 给 iconv-lite
    if (cp && cp !== '65001' && iconv.encodingExists(`cp${cp}`)) winCodePage = `cp${cp}`
  } catch {
    winCodePage = null
  }
  return winCodePage
}

/**
 * 输出解码：优先 UTF-8；出现替换字符且是 Windows 时，按控制台 OEM 代码页重解 ——
 * powershell 的 cmdlet 与 ipconfig 这类原生命令默认走 OEM/ANSI 码页，中文环境下是 CP936(GBK)。
 */
function decodeOutput(buf: Buffer): string {
  const utf8 = buf.toString('utf8')
  // 末尾的 U+FFFD 可能只是被捕获上限截断的多字节字符，不算「不是 UTF-8」
  const body = utf8.endsWith('\uFFFD') ? utf8.slice(0, -1) : utf8
  if (!body.includes('\uFFFD')) return utf8
  const codec = isWindows ? windowsCodePage() : null
  if (!codec) return utf8
  try {
    return iconv.decode(buf, codec)
  } catch {
    return utf8
  }
}

/** 超长输出保留头尾、中间省略；返回省略的字符数 */
function trimOutput(text: string): { output: string; elided: number } {
  if (text.length <= EXEC_OUTPUT_CHARS) return { output: text, elided: 0 }
  const elided = text.length - EXEC_OUTPUT_CHARS
  return {
    output: `${text.slice(0, EXEC_OUTPUT_HALF)}\n\n[…${elided} characters elided…]\n\n${text.slice(-EXEC_OUTPUT_HALF)}`,
    elided
  }
}

/** 运行本地命令所需的 invocation 形态（agent.ts 的 AgentTool 已带 signal） */
type ExecInvocation = { signal?: AbortSignal }

interface ExecResult {
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  durationMs: number
  output: string
  truncated: boolean
  timedOut: boolean
}

/** 连子孙一起杀：POSIX 用进程组（负 PID）；Windows 没有进程组信号，用 taskkill /T /F 树杀 */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  if (isWindows) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // taskkill 不可用 / 进程已退出
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // 进程已退出
  }
}

/**
 * 一次性执行：用 shellInvocation 选定的 shell 非交互执行 command，stdin 关闭（提示类命令直接 EOF）。
 * 超时或中断连子孙一起杀（POSIX 杀进程组 / Windows taskkill 树杀），避免留下孤儿进程。
 */
function runLocalCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  invocation: ExecInvocation
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
    const { file, args } = shellInvocation(command)
    const started = Date.now()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX 需要独立进程组才能整组杀；Windows 靠 taskkill /T，不 detached 以免多出一个控制台
        detached: !isWindows,
        windowsHide: true
      })
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let captured = 0
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid, 'SIGTERM')
      // 宽限期内不退出则强杀（Windows 上 taskkill 本身即强制终止）
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 2000)
    }, timeoutMs)
    const onAbort = (): void => {
      killTree(child.pid, 'SIGKILL')
      if (settled) return
      settled = true
      clearTimeout(timer)
      const err = new Error('Interrupted')
      err.name = 'AbortError'
      rejectPromise(err)
    }
    invocation.signal?.addEventListener('abort', onAbort, { once: true })
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length
      // 只缓存前一段：管道必须继续排空，否则子进程会写满缓冲区卡死
      const room = EXEC_CAPTURE_BYTES - captured
      if (room <= 0) return
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      chunks.push(slice)
      captured += slice.length
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      invocation.signal?.removeEventListener('abort', onAbort)
      rejectPromise(err)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      invocation.signal?.removeEventListener('abort', onAbort)
      // 先攒字节再统一解码：Windows 上需要按代码页兜底（见 decodeOutput）
      const { output, elided } = trimOutput(cleanOutput(decodeOutput(Buffer.concat(chunks))))
      resolvePromise({
        command,
        cwd,
        exitCode: code,
        signal: signal ?? null,
        durationMs: Date.now() - started,
        output: output.replace(/\s+$/, ''),
        truncated: elided > 0 || bytes > captured,
        timedOut
      })
    })
  })
}

/** 文件名 glob（仅 basename，支持 * ?）→ 正则；无通配符时按子串忽略大小写 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  if (!/[*?]/.test(glob)) return new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, '\\$&'), 'i')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

interface GrepHit {
  path: string
  line: number
  text: string
}

/** 递归收集待扫描文件（跳过点目录/点文件，控制文件数与深度） */
async function collectFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let truncated = false
  while (queue.length) {
    const { dir, depth } = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 无权限的子目录直接跳过，不中断整次检索
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth + 1 <= GREP_MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      if (files.length >= GREP_MAX_FILES) {
        truncated = true
        return { files, truncated }
      }
      files.push(full)
    }
  }
  return { files, truncated }
}

/** 本机工具：命令执行 + 文件读/写/编辑/检索 */
export const localTools: AnyTool[] = [
  defineTool('local_exec', {
    description: `Run one command on the LOCAL machine (this machine) and return its output, then exit — a one-shot runner, not an interactive shell, executed with ${SHELL_DOC}: stdin is closed (commands that need input get EOF immediately instead of hanging), no user terminal tab is opened, and there is no viewer to poll. Write the command for that shell (POSIX syntax on macOS/Linux, PowerShell syntax on Windows). cwd defaults to the home directory; nothing persists between calls, so pass an absolute path or cd inside the same command. Default timeout ${EXEC_DEFAULT_TIMEOUT_MS / 1000}s (max ${EXEC_MAX_TIMEOUT_MS / 1000}s); on timeout the whole process tree is killed and timedOut=true. Output is cleaned (ANSI removed, CRLF/\\r progress lines collapsed) and capped — when truncated, only the head and tail are kept: redirect long output to a file and page it with local_read instead. Use local_read/local_write/local_patch/local_grep for file work; use this for what they cannot do (build, test, git, package managers, process/service inspection).`,
    parameters: z.object({
      description: intentSchema,
      command: z
        .string()
        .min(1)
        .describe(
          `Command line, executed as a single ${isWindows ? 'PowerShell' : 'POSIX shell'} command`
        ),
      cwd: z
        .string()
        .optional()
        .describe('Working directory (absolute, ~ and relative-to-home accepted); default home'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Timeout in milliseconds; default ${EXEC_DEFAULT_TIMEOUT_MS}`)
    }),
    handler: async ({ command, cwd, timeoutMs }, invocation): Promise<ExecResult> => {
      const dir = localPath(cwd ?? '~')
      const st = await fsCall(dir, () => stat(dir))
      if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${dir}`)
      return runLocalCommand(
        command,
        dir,
        Math.min(timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS),
        invocation
      )
    }
  }),

  defineTool('local_list', {
    description:
      'List a local directory (this machine). Returns entries with name/path/isDir/isLink/size; hidden entries are included. The list is not recursive — use local_grep for content search or local_exec for tree/find.',
    parameters: z.object({
      description: intentSchema,
      path: z.string().optional().describe('Directory path; default home directory')
    }),
    handler: async ({ path }) => {
      const dir = localPath(path ?? '~')
      const entries = await fsCall(dir, () => readdir(dir, { withFileTypes: true }))
      const out = await Promise.all(
        entries.map(async (e) => {
          const full = join(dir, e.name)
          const isLink = e.isSymbolicLink()
          let size = 0
          try {
            size = (await lstat(full)).size
          } catch {
            size = 0 // 竞态删除/权限不足：大小不是本次列表的关键信息
          }
          return { name: e.name, path: full, isDir: e.isDirectory(), isLink, size }
        })
      )
      return out.sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
      )
    }
  }),

  defineTool('local_stat', {
    description:
      'Get local file/directory metadata (size, type, symlink, permission mode, timestamps) without reading content; throws if the path does not exist.',
    parameters: z.object({ description: intentSchema, path: z.string() }),
    handler: async ({ path }) => {
      const target = localPath(path)
      const st = await fsCall(target, () => lstat(target))
      return {
        path: target,
        isDir: st.isDirectory(),
        isFile: st.isFile(),
        isLink: st.isSymbolicLink(),
        size: st.size,
        mode: `0o${(st.mode & 0o7777).toString(8)}`,
        modified: st.mtimeMs,
        accessed: st.atimeMs
      }
    }
  }),

  defineTool('local_read', {
    description: `Read a local text file (this machine). The encoding is auto-detected (UTF-8/BOM, UTF-16, GB18030/GBK, Big5…), so text files from any platform read correctly. Returns a window of complete lines — ${READ_DEFAULT_LINES} lines by default, capped by size as well — instead of the whole file: the result carries totalLines and, when it was cut short, nextOffset, which you pass back as offset to continue. Content is verbatim (CRLF preserved), so a window can be used directly as local_patch anchors. Errors above 10MB and on binary files.`,
    parameters: z.object({
      description: intentSchema,
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
    handler: async ({ path, offset, limit }) => {
      const target = localPath(path)
      const { text, size } = await readText(target)
      const page = pageLines(text, offset ?? 1, limit ?? READ_DEFAULT_LINES)
      const hint = pageHint(page)
      return {
        path: target,
        content: page.content,
        size,
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

  defineTool('local_write', {
    description:
      'Write a local text file as UTF-8 (overwrites; creates the file and any missing parent directories). Use local_patch for targeted edits to an existing file instead of rewriting it — patch preserves the file’s original encoding, this tool does not.',
    parameters: z.object({
      description: intentSchema,
      path: z.string(),
      content: z.string()
    }),
    handler: async ({ path, content }) => {
      const target = localPath(path)
      let created = true
      try {
        await stat(target)
        created = false
      } catch {
        created = true
      }
      await fsCall(target, async () => {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
      })
      return { path: target, bytes: Buffer.byteLength(content, 'utf8'), created }
    }
  }),

  defineTool('local_patch', {
    description:
      'Edit part of a local text file precisely (anchor replacement): oldText is copied verbatim from local_read output (indentation included), newText is the replacement (empty string = delete the snippet). By default oldText must appear EXACTLY ONCE; if it appears multiple times (common in XML/JSON with repeated keys), pass occurrence (1-based) to replace the Nth match. Zero matches abort. Best for localized edits; the file’s original encoding and BOM are preserved on write. Use local_write to create files or rewrite whole content.',
    parameters: z.object({
      description: intentSchema,
      path: z.string(),
      oldText: z
        .string()
        .min(1)
        .describe('Original snippet to replace (anchor; copy verbatim from local_read output)'),
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
    handler: async ({ path, oldText, newText, occurrence }) => {
      const target = localPath(path)
      const before = await fsCall(target, () => stat(target))
      if (before.size > MAX_READ_BYTES)
        throw new Error(
          'File is too large to edit through local_patch (>10MB); edit it with local_exec instead'
        )
      const { text, encoding, bom, lossy } = await readText(target)
      if (lossy)
        throw new Error(
          'File encoding cannot be round-tripped losslessly; edit it with local_exec instead'
        )
      const { next } = applyAnchorPatch(text, oldText, newText, occurrence, 'local_read')
      // 并发防护：读改之间若文件被其他程序改动（mtime/size 变化）则拒绝，避免覆盖别人的更新
      const after = await fsCall(target, () => stat(target))
      if (after.mtimeMs !== before.mtimeMs || after.size !== before.size)
        throw new Error('File changed on disk during edit; re-run local_read and retry')
      // 按原编码写回：GBK/UTF-16 文本被当作 UTF-8 覆盖会毁掉整个文件
      const encoded = encodeFile(next, encoding, bom)
      await fsCall(target, () => writeFile(target, encoded))
      return { path: target, replaced: 1, size: encoded.length }
    }
  }),

  defineTool('local_grep', {
    description: `Search file contents on the LOCAL machine (this machine) with a regular expression, one hit per line. path may be a directory (recursive) or a single file; dot-directories and dot-files are skipped, and the walk stops after ${GREP_MAX_FILES} files, ${GREP_MAX_FILE_BYTES / 1024}KB per file or ${GREP_MAX_SCANNED_BYTES / 1024 / 1024}MB scanned total (the result reports truncated). Narrow the search with path and glob instead of grepping all of the home directory.`,
    parameters: z.object({
      description: intentSchema,
      pattern: z.string().min(1).describe('JavaScript regular expression to match per line'),
      path: z.string().optional().describe('Directory or file to search; default home directory'),
      glob: z
        .string()
        .optional()
        .describe(
          'File-name filter (basename, * and ? allowed, e.g. *.ts or config*); omit for all files'
        ),
      caseSensitive: z.boolean().optional().describe('Default false (case-insensitive)'),
      maxMatches: z.number().int().positive().optional().describe('Default 100, capped at 1000')
    }),
    handler: async ({ pattern, path, glob, caseSensitive, maxMatches }) => {
      const root = localPath(path ?? '~')
      const st = await fsCall(root, () => stat(root))
      let re: RegExp
      try {
        re = new RegExp(pattern, caseSensitive ? '' : 'i')
      } catch (err) {
        throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : err}`)
      }
      const nameRe = glob ? globToRegExp(glob) : null
      const limit = Math.min(maxMatches ?? 100, 1000)
      const files = st.isDirectory()
        ? await collectFiles(root)
        : { files: [root], truncated: false }
      const matches: GrepHit[] = []
      let scannedBytes = 0
      let filesScanned = 0
      let truncated = files.truncated
      for (const file of files.files) {
        if (matches.length >= limit) {
          truncated = true
          break
        }
        if (scannedBytes > GREP_MAX_SCANNED_BYTES) {
          truncated = true
          break
        }
        // glob 只比文件名：用 basename 以兼容 Windows 的反斜杠路径
        if (nameRe && !nameRe.test(basename(file))) continue
        let buf: Buffer
        try {
          const fst = await stat(file)
          if (!fst.isFile() || fst.size > GREP_MAX_FILE_BYTES) continue
          buf = await readFile(file)
        } catch {
          continue // 无权限/竞态删除：跳过该文件
        }
        // 与 local_read 同一套解码：UTF-8 走快路径，非 UTF-8 才让 chardet 探测（Windows 的 GBK 等）
        const dec = decodeFile(buf)
        if (dec.binary) continue
        scannedBytes += buf.length
        filesScanned += 1
        const lines = dec.text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          re.lastIndex = 0
          if (!re.test(line)) continue
          matches.push({ path: file, line: i + 1, text: line.trim().slice(0, 500) })
          if (matches.length >= limit) {
            truncated = true
            break
          }
        }
      }
      return {
        matches,
        filesScanned,
        scannedBytes,
        truncated,
        ...(truncated && matches.length >= limit
          ? {
              hint: `Stopped at ${matches.length} matches; narrow the search with path/glob or raise maxMatches`
            }
          : {})
      }
    }
  })
]
