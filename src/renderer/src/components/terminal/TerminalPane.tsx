import { useEffect, useRef, useState, type CSSProperties } from 'react'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import {
  attachTerminal,
  detachTerminal,
  fitTerminal,
  refreshTerminalFonts,
  focusTerminal,
  pasteTerminal,
  terminalSelection,
  findTerminal
} from '@/terminal/registry'
import { loadTerminalFonts } from '@/terminal/theme'
import { observeSettledResize } from '@/lib/observeSettledResize'
import { shellQuote } from '@shared/sftpPath'
import { INTERNAL_MIME } from '@/components/sftp/SftpTreeView'

export interface TerminalPaneProps {
  /** 注册表键（本地控制台 id 或 `${hostId}:${shellId}`） */
  instanceKey: string
  className?: string
  style?: CSSProperties
  /** 允许外部本地文件拖入插入本地路径（仅本地控制台；远程 shell 不响应本地文件） */
  acceptLocalFiles?: boolean
}

/**
 * 无状态终端挂载壳：把 registry 中的 xterm 实例 DOM 搬进容器；
 * 卸载时搬走（实例与 buffer 保留，PTY 输出期间照常写入）。
 * 拖放：SFTP 树条目 → 插入转义远端路径（任意终端）；本地文件 → 插入本地路径（仅本地控制台）。
 */
export function TerminalPane({
  instanceKey,
  className,
  style,
  acceptLocalFiles = false
}: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()
  const searchRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<boolean | null>(null)
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (searchOpen) {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }, [searchOpen])
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(''), 3000)
    return () => clearTimeout(timer)
  }, [message])
  const closeSearch = (): void => {
    setSearchOpen(false)
    focusTerminal(instanceKey)
  }
  const contextClipboard = async (): Promise<void> => {
    const selected = terminalSelection(instanceKey)
    try {
      if (selected) {
        await navigator.clipboard.writeText(selected)
        setMessage(t('terminalTools.copied'))
      } else {
        const text = await navigator.clipboard.readText()
        pasteTerminal(instanceKey, text)
        focusTerminal(instanceKey)
      }
    } catch {
      setMessage(t('terminalTools.clipboardFailed'))
    }
  }
  const [dropArmed, setDropArmed] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let stopResize: (() => void) | undefined
    let disposed = false
    // xterm measures glyph cells on open; font loading must finish before that measurement.
    void loadTerminalFonts()
      .catch((error) => console.error('Failed to load bundled terminal fonts', error))
      .then(() => {
        if (disposed || !host.isConnected) return
        attachTerminal(instanceKey, host)
        stopResize = observeSettledResize(host, () => fitTerminal(instanceKey, host))
        refreshTerminalFonts(instanceKey)
      })
    return () => {
      disposed = true
      stopResize?.()
      detachTerminal(instanceKey, host)
    }
  }, [instanceKey])

  const pastePaths = (paths: string[]): void => {
    if (paths.length > 0) pasteTerminal(instanceKey, paths.map(shellQuote).join(' '))
    focusTerminal(instanceKey) // 拖放后焦点回终端，路径立即可续写命令
  }

  return (
    <div
      ref={hostRef}
      className={cn('relative h-full w-full bg-terminal outline-none', className)}
      style={style}
      onKeyDownCapture={(e) => {
        const searchShortcut =
          e.key.toLowerCase() === 'f' &&
          !e.altKey &&
          (window.aterm.window.platform === 'darwin' ? e.metaKey : e.ctrlKey && e.shiftKey)
        if (searchShortcut) {
          e.preventDefault()
          e.stopPropagation()
          setSearchOpen(true)
          searchRef.current?.focus()
        }
      }}
      onMouseDownCapture={(e) => {
        if (e.button === 2 && !(e.target as HTMLElement).closest('[data-terminal-search]')) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
      onContextMenuCapture={(e) => {
        if ((e.target as HTMLElement).closest('[data-terminal-search]')) return
        e.preventDefault()
        e.stopPropagation()
        void contextClipboard()
      }}
      onDragOver={(e) => {
        const ok =
          e.dataTransfer.types.includes(INTERNAL_MIME) ||
          (acceptLocalFiles && e.dataTransfer.types.includes('Files'))
        if (!ok) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        // 关键：阻断冒泡到 window——SFTP 树内 react-arborist 挂的 react-dnd(HTML5Backend)
        // 会对外来拖拽覆写 dropEffect='none'，导致 drop 事件不触发（同 SftpTreeView 行级处理）
        e.stopPropagation()
        setDropArmed(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropArmed(false)
      }}
      onDrop={(e) => {
        setDropArmed(false)
        e.stopPropagation()
        // SFTP 树条目 → 远端路径
        const raw = e.dataTransfer.getData(INTERNAL_MIME)
        if (raw !== '') {
          e.preventDefault()
          try {
            const paths = (JSON.parse(raw) as { paths?: string[] }).paths ?? []
            pastePaths(paths)
          } catch {
            /* 忽略非法载荷 */
          }
          return
        }
        // 外部本地文件 → 本地路径（仅本地控制台）
        if (acceptLocalFiles && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          e.preventDefault()
          pastePaths(Array.from(e.dataTransfer.files).map((f) => window.aterm.sftp.pathForFile(f)))
        }
      }}
    >
      {searchOpen && (
        <div
          data-terminal-search
          className="absolute right-0 top-0 z-20 max-w-full rounded-md border border-line bg-raised p-2 shadow-md"
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <input
              ref={searchRef}
              aria-label={t('terminalTools.search')}
              placeholder={t('terminalTools.search')}
              className="min-w-0 w-48 bg-transparent text-body text-fg outline-none"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setFound(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  closeSearch()
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (query) setFound(findTerminal(instanceKey, query, e.shiftKey))
                }
              }}
            />
            <button
              type="button"
              aria-label={t('common.close')}
              className="shrink-0 text-body text-muted hover:text-fg"
              onClick={closeSearch}
            >
              ×
            </button>
          </div>
          <p className="mt-1 text-caption text-muted">{t('terminalTools.searchKeys')}</p>
          {found === false && (
            <p role="status" className="text-caption text-muted">
              {t('terminalTools.noMatch')}
            </p>
          )}
        </div>
      )}
      {message && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-1 right-1 z-20 rounded bg-raised px-2 py-1 text-caption text-fg"
        >
          {message}
        </span>
      )}
      {dropArmed && (
        // -inset-2.5 + r10：对齐外层 WorkspacePane 终端卡片边缘（卡片内容区 inset-[10px]、圆角 10px）
        <div className="pointer-events-none absolute -inset-2.5 z-10 rounded-[10px] border-[1.5px] border-dashed border-at-accent/80 bg-at-accent/5" />
      )}
    </div>
  )
}
