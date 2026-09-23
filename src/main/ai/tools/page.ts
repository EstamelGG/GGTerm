/**
 * 行窗口分页（sftp_read / local_read 共用）：把整文件文本切成「行窗口」，让模型按 offset 续读，
 * 而不是一次把大文件灌进上下文。行号 1-based；content 保持逐行原文（CRLF 的 \r 保留、行间以 \n 连接），
 * 因此窗口内容可直接当作 sftp_patch / local_patch 的锚点。
 */

/** limit 上限（超过按上限处理） */
const READ_MAX_LINES = 5000
/** limit 缺省值 */
export const READ_DEFAULT_LINES = 500
/** 单窗口字符上限：长行文件按行数切仍可能爆窗口，行数之外再加一道闸 */
const READ_MAX_CHARS = 24 * 1024
/** 单行硬上限：超过则就地截断（否则一行 minified 内容就能独占整个窗口） */
const READ_MAX_LINE_CHARS = 4 * 1024

export interface LineWindow {
  content: string
  totalLines: number
  fromLine: number
  toLine: number
  /** 后面还有内容（toLine < totalLines） */
  truncated: boolean
  /** 续读起点；truncated 时给出，直接作为下次 offset */
  nextOffset?: number
  /** 就地截断过的行号（内容不再是该行原文，不能用于锚点匹配） */
  longLines: number[]
}

/** 按 \n 切行；以换行结尾的文件去掉 split 多出的空尾元素 */
function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

export function pageLines(text: string, offset = 1, limit = READ_DEFAULT_LINES): LineWindow {
  const lines = splitLines(text)
  const totalLines = lines.length
  const from = Math.max(1, offset)
  if (totalLines > 0 && from > totalLines)
    throw new Error(
      `offset ${from} is past the end of the file (${totalLines} lines); start from 1`
    )
  const max = Math.max(1, Math.min(limit, READ_MAX_LINES))
  const out: string[] = []
  const longLines: number[] = []
  let used = 0
  let toLine = from - 1
  for (let i = from - 1; i < totalLines && out.length < max; i++) {
    const line = lines[i]!
    const bytes = Buffer.byteLength(line, 'utf8')
    // 收满预算即停（至少收一行，避免首行超长时返回空窗口）
    if (out.length > 0 && used + bytes > READ_MAX_CHARS) break
    if (bytes > READ_MAX_LINE_CHARS) {
      let kept = line.slice(0, READ_MAX_LINE_CHARS)
      // 截断点避开代理对（否则半个字符会污染后续内容）
      const last = kept.charCodeAt(kept.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1)
      out.push(`${kept}\n[line ${i + 1} truncated: ${bytes} bytes total]`)
      longLines.push(i + 1)
      used += READ_MAX_LINE_CHARS
    } else {
      out.push(line)
      used += bytes + 1
    }
    toLine = i + 1
  }
  const truncated = toLine < totalLines
  return {
    content: out.join('\n'),
    totalLines,
    fromLine: from,
    toLine,
    truncated,
    ...(truncated ? { nextOffset: toLine + 1 } : {}),
    longLines
  }
}

/** 分页后给模型的一句续读提示（行号 + 下次 offset），未截断时为空串 */
export function pageHint(w: LineWindow): string {
  if (!w.truncated) return ''
  return `Showing lines ${w.fromLine}-${w.toLine} of ${w.totalLines}. Call again with offset=${w.nextOffset} to continue.`
}
