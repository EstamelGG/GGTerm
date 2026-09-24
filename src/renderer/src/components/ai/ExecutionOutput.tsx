import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExecutionSnapshot } from '@shared/execution'
import { errorMessage } from '@shared/error'
import { loadTerminalFonts } from '@/terminal/theme'
import {
  attachTerminal,
  createTerminal,
  disposeTerminal,
  fitTerminal,
  refreshTerminalFonts,
  writeTerminal
} from '@/terminal/registry'
import { observeSettledResize } from '@/lib/observeSettledResize'
import '@xterm/xterm/css/xterm.css'

export function ExecutionOutput({ task }: { task: ExecutionSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  useEffect(() => {
    const container = host.current
    if (!container) return
    const key = `execution-view:${task.sessionId}:${task.executionId}`
    let active = true
    let cursor = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopResize: (() => void) | undefined
    const refresh = async (): Promise<void> => {
      try {
        const result = await window.aterm.executions.read(task.sessionId, task.executionId, cursor)
        if (!active) return
        cursor = result.cursor
        if (result.truncated) setTruncated(true)
        writeTerminal(key, result.output)
        if (result.status === 'starting' || result.status === 'running')
          timer = setTimeout(() => void refresh(), 500)
      } catch (reason) {
        if (active) setError(errorMessage(reason))
      }
    }
    void loadTerminalFonts()
      .then(() => {
        if (!active) return
        // No stdin listener, no paste route, and no backend PTY resize: this is only a view.
        createTerminal(key, { readOnly: true, onData: () => {} })
        attachTerminal(key, container)
        refreshTerminalFonts(key)
        stopResize = observeSettledResize(container, () => fitTerminal(key, container))
        void refresh()
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason))
      })
    return () => {
      active = false
      clearTimeout(timer)
      stopResize?.()
      disposeTerminal(key)
    }
  }, [task.sessionId, task.executionId])
  return (
    <>
      {truncated && (
        <p role="status" className="text-caption text-muted">
          {t('execution.truncated')}
        </p>
      )}
      <div className="relative h-full min-w-0 overflow-hidden rounded-[10px] border border-terminal-border bg-terminal">
        {/* 与用户 shell 终端一致：inset-[10px] 让文本不贴边，fit 计算以内容区为准 */}
        <div ref={host} aria-label={t('execution.output')} className="absolute inset-[10px]" />
      </div>
      {error && (
        <p role="alert" className="text-minor text-danger">
          {error}
        </p>
      )}
    </>
  )
}
