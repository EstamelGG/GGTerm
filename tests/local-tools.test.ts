import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { afterAll, expect, it, vi } from 'vitest'
import { applyAnchorPatch } from '../src/main/ai/tools/anchorPatch'
import { localTools } from '../src/main/ai/tools/local'
import { pageLines } from '../src/main/ai/tools/page'

// localAccess 只负责把 EPERM/EACCES 换成本地化引导文案；单测不加载 electron 侧
vi.mock('../src/main/localAccess', () => ({ localAccessDeniedError: () => null }))

const root = mkdtempSync(join(tmpdir(), 'ggterm-local-tools-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const invocation = { sessionId: 'session', toolCallId: 'call' }

/** 工具 handler 的入参/出参在测试里按 unknown 处理，避免与 zod 推导类型纠缠 */
async function run(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = localTools.find((x) => x.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  const handler = tool.handler as (i: unknown, inv: unknown) => Promise<Record<string, unknown>>
  return await handler(input, invocation)
}

/* ---------------- 分页（sftp_read / local_read 共用） ---------------- */

it('returns a line window with a continuation offset instead of the whole file', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const page = pageLines(text, 1, 4)
  expect(page.content).toBe('line 1\nline 2\nline 3\nline 4')
  expect(page).toMatchObject({ totalLines: 10, fromLine: 1, toLine: 4, truncated: true })
  expect(page.nextOffset).toBe(5)
  const tail = pageLines(text, 9, 4)
  expect(tail).toMatchObject({ fromLine: 9, toLine: 10, truncated: false })
  expect(tail.nextOffset).toBeUndefined()
  expect(tail.content).toBe('line 9\nline 10')
})

it('keeps CRLF verbatim so a window can be reused as a patch anchor', () => {
  const page = pageLines('a\r\nb\r\nc\r\n', 2, 1)
  expect(page.content).toBe('b\r')
  expect(page.totalLines).toBe(3)
})

it('reports offsets past the end and truncates a single overlong line in place', () => {
  expect(() => pageLines('a\nb\n', 5, 1)).toThrow('past the end')
  const page = pageLines('x'.repeat(9000), 1, 5)
  expect(page.totalLines).toBe(1)
  expect(page.longLines).toEqual([1])
  expect(page.content.startsWith('x'.repeat(100))).toBe(true)
  expect(page.content).toContain('[line 1 truncated: 9000 bytes total]')
})

/* ---------------- 锚点替换（sftp_patch / local_patch 共用） ---------------- */

it('replaces a unique anchor, picks the Nth match, and rejects ambiguity', () => {
  expect(applyAnchorPatch('a\nb\nc\n', 'b', 'B', undefined, 'local_read').next).toBe('a\nB\nc\n')
  expect(applyAnchorPatch('x\nx\n', 'x', 'y', 2, 'local_read').next).toBe('x\ny\n')
  expect(() => applyAnchorPatch('x\nx\n', 'x', 'y', undefined, 'local_read')).toThrow(
    'matched 2 places'
  )
  expect(() => applyAnchorPatch('a\n', 'z', 'y', undefined, 'local_read')).toThrow(
    'run local_read to verify first'
  )
  expect(() => applyAnchorPatch('a\n', 'a', 'a', undefined, 'local_read')).toThrow(
    'oldText equals newText'
  )
})

/* ---------------- 本地文件工具 ---------------- */

it('writes a file (creating parents), reads it back and pages it', async () => {
  const file = join(root, 'nested', 'page.txt')
  const written = await run('local_write', {
    path: file,
    content: Array.from({ length: 6 }, (_, i) => `row ${i + 1}`).join('\n')
  })
  expect(written).toMatchObject({ path: file, created: true })
  expect(written.bytes).toBeGreaterThan(0)

  const read = await run('local_read', { path: file, offset: 2, limit: 2 })
  expect(read.content).toBe('row 2\nrow 3')
  expect(read).toMatchObject({ totalLines: 6, fromLine: 2, toLine: 2 + 1, truncated: true })
  expect(read.nextOffset).toBe(4)
  expect(String(read.hint)).toContain('offset=4')

  const again = await run('local_write', { path: file, content: 'x' })
  expect(again.created).toBe(false)
})

it('refuses directories and binary files on read', async () => {
  await expect(run('local_read', { path: root })).rejects.toThrow('use local_list')
  const bin = join(root, 'blob.bin')
  writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02]))
  await expect(run('local_read', { path: bin })).rejects.toThrow('Binary file')
})

it('detects non-UTF-8 encodings and writes back in the original encoding (GBK case)', async () => {
  const file = join(root, 'gbk.txt')
  // 编码探测需要足够样本：真实的 GBK 文本通常远长于一行；关键词只出现一次，便于锚点唯一匹配
  const lines = Array.from({ length: 12 }, (_, i) => `第${i + 1}行：中文内容与标点，用于编码探测。`)
  lines[5] = '第六行：这里有一个 needle 关键词。'
  const original = `${lines.join('\n')}\n`
  writeFileSync(file, iconv.encode(original, 'gb18030'))

  const read = await run('local_read', { path: file })
  expect(read.content).toBe(lines.join('\n'))

  await run('local_patch', { path: file, oldText: 'needle', newText: 'marker' })
  const bytes = readFileSync(file)
  expect(iconv.decode(bytes, 'gb18030')).toBe(original.replace('needle', 'marker'))
  // 写回仍是 GB18030（不是被 UTF-8 覆盖）：按 UTF-8 严格解码会失败
  expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow()
})

it('reads UTF-16LE files (PowerShell redirect default)', async () => {
  const file = join(root, 'utf16.txt')
  writeFileSync(
    file,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\nbeta\n', 'utf16le')])
  )
  const read = await run('local_read', { path: file })
  expect(read.content).toBe('alpha\nbeta')
})

it('patches a file in place and reports the resulting size', async () => {
  const file = join(root, 'patch.txt')
  writeFileSync(file, 'alpha\nbeta\n')
  const res = await run('local_patch', {
    path: file,
    oldText: 'beta',
    newText: 'gamma',
    occurrence: undefined
  })
  expect(res).toMatchObject({ path: file, replaced: 1, size: 12 })
  const read = await run('local_read', { path: file })
  expect(read.content).toBe('alpha\ngamma')
})

it('lists a directory (dirs first) and stats a path', async () => {
  const dir = join(root, 'listing')
  await mkdir(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'b.txt'), 'b')
  writeFileSync(join(dir, 'a.txt'), 'aa')
  const entries = (await run('local_list', { path: dir })) as unknown as Array<{
    name: string
    isDir: boolean
    size: number
    path: string
  }>
  expect(Array.isArray(entries)).toBe(true)
  expect(entries.map((e) => e.name)).toEqual(['sub', 'a.txt', 'b.txt'])
  expect(entries[1]).toMatchObject({ isDir: false, size: 2 })

  const st = await run('local_stat', { path: join(dir, 'a.txt') })
  expect(st).toMatchObject({ isDir: false, isFile: true, isLink: false, size: 2 })
  await expect(run('local_stat', { path: join(dir, 'missing') })).rejects.toThrow()
})

it('greps file contents with a glob filter and skips dot-directories', async () => {
  const dir = join(root, 'grep')
  await mkdir(join(dir, '.git'), { recursive: true })
  await mkdir(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'const needle = 1\nother\n')
  writeFileSync(join(dir, 'src', 'b.md'), 'needle in markdown\n')
  writeFileSync(join(dir, '.git', 'c.ts'), 'needle in git dir\n')

  const tsOnly = await run('local_grep', { pattern: 'needle', path: dir, glob: '*.ts' })
  const hits = tsOnly.matches as Array<{ path: string; line: number; text: string }>
  expect(hits).toHaveLength(1)
  expect(hits[0]).toMatchObject({
    path: join(dir, 'src', 'a.ts'),
    line: 1,
    text: 'const needle = 1'
  })

  const all = await run('local_grep', { pattern: 'needle', path: dir })
  expect((all.matches as unknown[]).length).toBe(2)
  expect(all.filesScanned).toBeGreaterThan(0)
})

it('runs a one-shot local command and reports exit code, cwd and output', async () => {
  // 命令写成两个平台都成立的形态（POSIX sh / PowerShell / cmd 都认 echo、exit）
  const ok = await run('local_exec', { command: 'echo hello-local', cwd: root })
  expect(ok.exitCode).toBe(0)
  expect(ok.timedOut).toBe(false)
  expect(String(ok.output)).toContain('hello-local')
  expect(ok.cwd).toBe(root)

  const failed = await run('local_exec', { command: 'exit 3', cwd: root })
  expect(failed.exitCode).toBe(3)
})

it('kills the process tree on timeout and flags timedOut', async () => {
  // node 起一个 30s 空转：比 sleep 更跨平台（PowerShell/cmd/POSIX 都有 node 之外的不同别名）
  const res = await run('local_exec', {
    command: 'node -e "setTimeout(function(){},30000)"',
    cwd: root,
    timeoutMs: 300
  })
  expect(res.timedOut).toBe(true)
  // 被信号杀死时 exitCode 为 null（signal=SIGTERM）；Windows taskkill /F 可能给出非 0 退出码
  expect(res.durationMs).toBeLessThan(10_000)
  expect(res.exitCode === null || res.exitCode !== 0).toBe(true)
})

it('accepts ~ as the home directory on every platform', async () => {
  const st = await run('local_stat', { path: '~' })
  expect(st.path).toBe(homedir())
  expect(st.isDir).toBe(true)
})

it('rejects a cwd that is not a directory', async () => {
  await expect(run('local_exec', { command: 'true', cwd: join(root, 'nope') })).rejects.toThrow()
})

it('exposes object-rooted schemas (runtime discovery requires it) with stable names', () => {
  const names = localTools.map((t) => t.name)
  expect(names).toEqual([
    'local_exec',
    'local_list',
    'local_stat',
    'local_read',
    'local_write',
    'local_patch',
    'local_grep'
  ])
  expect(new Set(names).size).toBe(names.length)
  for (const tool of localTools) {
    const schema = (
      tool.parameters as unknown as { toJSONSchema(): Record<string, unknown> }
    ).toJSONSchema()
    expect(schema.type).toBe('object')
    expect(schema).not.toHaveProperty('oneOf')
    expect(schema).not.toHaveProperty('anyOf')
  }
  const exec = localTools.find((t) => t.name === 'local_exec')!.parameters as unknown as {
    toJSONSchema(): { required: string[] }
  }
  expect(exec.toJSONSchema().required).toContain('command')
})
