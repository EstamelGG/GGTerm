import { observeSettledResize } from '@/lib/observeSettledResize'
import { useResizePreview } from '@/lib/useResizePreview'
import { useEffect, useRef, useState } from 'react'
const WIDTH_KEY = 'ggterm.sftpWidth'
const MIN_WIDTH = 240
const MAX_WIDTH = 520
const WORKSPACE_MIN_WIDTH = 360

function loadWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY)
  const v = raw === null ? NaN : Number(raw)
  return Number.isFinite(v) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v)) : 300
}

/** 左栏收纳状态（'0' 收起 / 其它展开）：与宽度同存 localStorage，跨会话沿用 */
const OPEN_KEY = 'ggterm.sftpOpen'

function loadSftpOpen(): boolean {
  return localStorage.getItem(OPEN_KEY) !== '0'
}

/** 上部文件编辑区高度（px）：null = 未拖过，与终端区 flex 均分（默认 50/50） */
const EDITOR_H_KEY = 'ggterm.sessionEditorH'
const EDITOR_H_MIN = 140
/** 下区最小高度（标签栏 + 可用终端视口） */
const SHELL_H_MIN = 160

function chromeRowHeight(): number {
  return (
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--at-chrome-row-height')
    ) || 36
  )
}

function loadEditorH(): number | null {
  const raw = localStorage.getItem(EDITOR_H_KEY)
  const v = raw === null ? NaN : Number(raw)
  return Number.isFinite(v) && v >= EDITOR_H_MIN ? v : null
}

interface HostLayout {
  rootRef: React.RefObject<HTMLDivElement | null>
  sftpOverlay: boolean
  sftpVisible: boolean
  toggleSftp: () => void
  effectiveWidth: number
  widthResize: ReturnType<typeof useResizePreview>
  dragging: boolean
  previewWidth: number | null
  widthPreviewRef: React.RefObject<HTMLDivElement | null>
  workspaceRef: React.RefObject<HTMLDivElement | null>
  previewH: number | null
  heightPreviewRef: React.RefObject<HTMLDivElement | null>
  editorH: number | null
  maxEditorH: number
  heightResize: ReturnType<typeof useResizePreview>
}
export function useHostLayout(canSftp: boolean): HostLayout {
  const [width, setWidth] = useState(() => loadWidth())
  /** 左栏收纳：面板保持挂载（树/选中/滚动不丢），只把宽度归零 */
  const [sftpOpen, setSftpOpen] = useState(loadSftpOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState(() => ({
    width: 980,
    height: 540,
    overlayOpen: false,
    chromeHeight: chromeRowHeight()
  }))
  const sftpOverlay = bounds.width < MIN_WIDTH + WORKSPACE_MIN_WIDTH + 1
  const sftpVisible = canSftp && (sftpOverlay ? bounds.overlayOpen : sftpOpen)
  const toggleSftp = (): void => {
    if (sftpOverlay) {
      setBounds((prev) => ({ ...prev, overlayOpen: !prev.overlayOpen }))
    } else {
      const next = !sftpOpen
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
      setSftpOpen(next)
    }
  }
  const widthPreviewRef = useRef<HTMLDivElement>(null)
  // 上部编辑区高度（竖向 splitter；null = 均分）
  const [editorH, setEditorH] = useState<number | null>(() => loadEditorH())
  const heightPreviewRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    return observeSettledResize(root, () =>
      setBounds({
        width: root.clientWidth,
        height: root.clientHeight,
        overlayOpen: false,
        chromeHeight: chromeRowHeight()
      })
    )
  }, [])
  const maxSftpWidth = Math.max(
    MIN_WIDTH,
    Math.min(MAX_WIDTH, bounds.width - WORKSPACE_MIN_WIDTH - 1)
  )
  const effectiveWidth = Math.min(width, maxSftpWidth)
  // Reserve both tab rows and the divider in addition to the terminal viewport.
  const chromeHeight = bounds.chromeHeight * 2 + 1
  const maxEditorH = Math.max(EDITOR_H_MIN, bounds.height - SHELL_H_MIN - chromeHeight)
  const widthResize = useResizePreview({
    value: effectiveWidth,
    min: MIN_WIDTH,
    max: maxSftpWidth,
    onCommit: (next) => {
      setWidth(next)
      localStorage.setItem(WIDTH_KEY, String(next))
    },
    onPreview: (next) => {
      if (widthPreviewRef.current) widthPreviewRef.current.style.left = `${next - 1}px`
    }
  })
  const heightResize = useResizePreview({
    value: Math.min(
      editorH ?? Math.round(Math.max(0, bounds.height - chromeHeight) / 2),
      maxEditorH
    ),
    min: EDITOR_H_MIN,
    max: maxEditorH,
    axis: 'y',
    onCommit: (next) => {
      setEditorH(next)
      localStorage.setItem(EDITOR_H_KEY, String(next))
    },
    onPreview: (next) => {
      if (heightPreviewRef.current)
        heightPreviewRef.current.style.top = `calc(${next}px + var(--at-chrome-row-height))`
    }
  })
  const previewWidth = widthResize.preview
  const previewH = heightResize.preview
  const dragging = previewWidth !== null

  return {
    rootRef,
    sftpOverlay,
    sftpVisible,
    toggleSftp,
    effectiveWidth,
    widthResize,
    dragging,
    previewWidth,
    widthPreviewRef,
    workspaceRef,
    previewH,
    heightPreviewRef,
    editorH,
    maxEditorH,
    heightResize
  }
}
