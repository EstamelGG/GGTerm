import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExecutionSnapshot } from '@shared/execution'
import { errorMessage } from '@shared/error'
import { DialogShell } from '@/components/ui/DialogShell'
import { Button } from '@/components/form/Buttons'
import { useConnectionsStore } from '@/stores/connections'
import { cn } from '@/lib/utils'
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

function ExecutionOutput({ task }: { task: ExecutionSnapshot }): React.JSX.Element {
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
      <div className="relative h-80 min-w-0 overflow-hidden rounded-[10px] border border-terminal-border bg-terminal">
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

export default function ExecutionSessionsDialog({
  sessionId,
  hostId,
  onClose
}: {
  /** AI 会话模式：查看该会话发起的执行（对话页入口） */
  sessionId?: string
  /** 主机模式：跨会话查看该主机的全部执行（主机列表入口） */
  hostId?: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const connections = useConnectionsStore((state) => state.connections)
  const [tasks, setTasks] = useState<ExecutionSnapshot[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [terminating, setTerminating] = useState(false)
  const task = tasks.find((item) => item.executionId === selected) ?? tasks.at(-1)
  const canTerminate =
    task && !task.terminationRequested && (task.status === 'starting' || task.status === 'running')
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        // 会话模式可叠加 hostId 过滤 = 只看该会话在某主机下的执行
        const result = await window.aterm.executions.list(sessionId ?? '', hostId)
        if (active) {
          setTasks(result)
          setLoading(false)
        }
      } catch (reason) {
        if (active) {
          setError(errorMessage(reason))
          setLoading(false)
        }
      }
      if (active) timer = setTimeout(() => void refresh(), 1000)
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [sessionId, hostId])
  const terminate = async (): Promise<void> => {
    if (!confirmId || !task || terminating) return
    setTerminating(true)
    try {
      // 终止按任务自身的所属 AI 会话（主机模式下任务可能来自不同会话）
      await window.aterm.executions.terminate(task.sessionId, confirmId)
      setTasks((items) =>
        items.map((item) =>
          item.executionId === confirmId ? { ...item, terminationRequested: true } : item
        )
      )
      setConfirmId(null)
    } catch (reason) {
      setError(errorMessage(reason))
      setConfirmId(null)
    } finally {
      setTerminating(false)
    }
  }
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t('execution.title')}
      width={960}
      footer={
        <>
          <span className="mr-auto text-caption text-muted">{t('execution.keepRunning')}</span>
          <Button
            variant="danger"
            title={t('execution.terminate')}
            disabled={!canTerminate || terminating}
            onClick={() => setConfirmId(task!.executionId)}
          />
        </>
      }
    >
      <p className="mb-3 text-minor text-muted">{t('execution.readOnly')}</p>
      {error && (
        <p role="alert" className="mb-2 text-minor text-danger">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-body text-muted">{t('ai.loading')}</p>
      ) : !tasks.length ? (
        <p className="text-body text-muted">{t('execution.empty')}</p>
      ) : (
        <div className="flex min-h-0 gap-3">
          <div
            className="max-h-96 w-52 shrink-0 space-y-1 overflow-y-auto"
            role="list"
            aria-label={t('execution.list')}
          >
            {tasks.map((item) => (
              <button
                key={item.executionId}
                type="button"
                aria-pressed={task?.executionId === item.executionId}
                onClick={() => setSelected(item.executionId)}
                title={item.command || t('execution.shell')}
                className={cn(
                  'w-full rounded-md border px-2 py-1.5 text-left',
                  task?.executionId === item.executionId
                    ? 'border-at-accent/45 bg-raised'
                    : 'border-line hover:bg-hover'
                )}
              >
                <span className="block truncate font-mono text-body text-fg">
                  {item.command || t('execution.shell')}
                </span>
                <span className="flex items-center gap-2 text-caption text-muted">
                  <span className="min-w-0 flex-1 truncate">
                    {connections.find((conn) => conn.id === item.hostId)?.name ?? item.hostId}
                  </span>
                  <span className="shrink-0">{t(`execution.${item.status}`)}</span>
                </span>
              </button>
            ))}
          </div>
          {task && (
            <div className="min-w-0 flex-1">
              {task.error && (
                <p role="alert" className="mb-2 text-minor text-danger">
                  {task.error}
                </p>
              )}
              <ExecutionOutput key={task.executionId} task={task} />
            </div>
          )}
        </div>
      )}
      {confirmId && (
        <DialogShell
          open
          title={t('execution.terminate')}
          onOpenChange={(open) => {
            if (!open && !terminating) setConfirmId(null)
          }}
          dismissable={!terminating}
          footer={
            <>
              <Button
                variant="ghost"
                title={t('common.cancel')}
                disabled={terminating}
                onClick={() => setConfirmId(null)}
              />
              <Button
                variant="danger"
                title={t('execution.terminate')}
                disabled={terminating}
                onClick={() => void terminate()}
              />
            </>
          }
        >
          <p className="text-body text-fg">{t('execution.confirmTerminate')}</p>
        </DialogShell>
      )}
    </DialogShell>
  )
}
