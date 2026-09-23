/**
 * 锚点替换（sftp_patch / local_patch 共用）：oldText 原文唯一匹配（或指定第 N 个匹配）后替换为 newText。
 * 原文逐字符比较、保守计重叠，带 CRLF 容错（agent 锚点通常带 \n）。
 */

export interface AnchorPatchResult {
  /** 替换后的完整内容 */
  next: string
  /** 实际参与匹配的锚点（可能是 CRLF 归一后的形态） */
  anchor: string
  /** 与 anchor 对齐后的替换文本 */
  patch: string
}

/**
 * @param readTool 提示文案里引用的读工具名（sftp_read / local_read）
 */
export function applyAnchorPatch(
  content: string,
  oldText: string,
  newText: string,
  occurrence: number | undefined,
  readTool: string
): AnchorPatchResult {
  if (oldText === newText) throw new Error('oldText equals newText; nothing to change')
  const indicesOf = (needle: string): number[] => {
    const idx: number[] = []
    for (let i = content.indexOf(needle); i !== -1; i = content.indexOf(needle, i + 1)) idx.push(i)
    return idx
  }
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
    throw new Error(`oldText not found in the file (0 matches); run ${readTool} to verify first`)
  let index: number
  if (occurrence != null) {
    if (occurrence > indices.length)
      throw new Error(
        `oldText matched ${indices.length} place(s); occurrence ${occurrence} is out of range`
      )
    index = indices[occurrence - 1]!
  } else {
    if (indices.length > 1)
      throw new Error(
        `oldText matched ${indices.length} places; use a longer snippet or the occurrence parameter to pick one`
      )
    index = indices[0]!
  }
  return {
    next: content.slice(0, index) + patch + content.slice(index + anchor.length),
    anchor,
    patch
  }
}
