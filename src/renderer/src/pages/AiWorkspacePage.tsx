import { ActivityPanelHeader } from '@/components/activity/ActivityPanelHeader'
import { QuestionCard } from '@/components/ai/QuestionCard'
import { IconButton } from '@/components/ui/IconButton'
import { isBusy, sessionTitle, useAiStore } from '@/stores/ai'
import { useHumanInputStore } from '@/stores/humanInput'
import { useQuestionsStore } from '@/stores/questions'
import { isToolUIPart } from 'ai'
import { ArrowDown, ArrowLeft, Bot, Loader2, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { ChatComposer } from './ai/ChatComposer'
import { HumanInputCard } from './ai/HumanInputCard'
import { MessageItem } from './ai/MessageItem'
import { SessionList } from './ai/SessionList'

/** 「回到底部」判定阈值：距底小于该值视为跟随中 */
const FOLLOW_THRESHOLD = 48

export function AiWorkspacePage(): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useAiStore((s) => s.sessions)
  const activeId = useAiStore((s) => s.activeId)
  const init = useAiStore((s) => s.init)
  const newSession = useAiStore((s) => s.newSession)
  const closeSession = useAiStore((s) => s.closeSession)
  const activate = useAiStore((s) => s.activate)
  const send = useAiStore((s) => s.send)
  const cancel = useAiStore((s) => s.cancel)

  const active = sessions.find((s) => s.id === activeId) ?? null
  const initError = useAiStore((s) => s.initError)
  /** 本会话挂起的人工输入待办：卡片排在对话末尾（见 HumanInputCard），不嵌进历史工具卡 */
  const questionRequests = useQuestionsStore(
    useShallow((s) => Object.values(s.pending).filter((r) => r.sessionId === activeId))
  )
  const inputRequests = useHumanInputStore(
    useShallow((s) => Object.values(s.pending).filter((r) => r.sessionId === activeId))
  )

  /** 面板视图：chat = 当前会话对话；list = 全部会话列表（VS Code Copilot 风格导航） */
  const [view, setView] = useState<'chat' | 'list'>(() =>
    activeId || useAiStore.getState().viewChatRequest > 0 ? 'chat' : 'list'
  )

  const scrollRef = useRef<HTMLDivElement>(null)

  /* 滚动跟随：上翻即停止贴底（想回看历史时不被流式输出拽走），发送/切会话恢复跟随 */
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    void init()
  }, [init])

  /* 外部入口（主机备注「Agent 代填」等）发起的对话：列表视图下切回对话视图，否则看不到刚发出的消息。
     渲染期调整（与本文件其他判重同套路），挂载时视为已消费，不影响正常进入页面时的视图 */
  const viewChatRequest = useAiStore((s) => s.viewChatRequest)
  const [seenViewChatRequest, setSeenViewChatRequest] = useState(viewChatRequest)
  if (viewChatRequest !== seenViewChatRequest) {
    setSeenViewChatRequest(viewChatRequest)
    setView('chat')
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el && following) el.scrollTop = el.scrollHeight
    // 末尾的输入卡片出现/收起时同样贴底（只在跟随态）
  }, [active?.messages, following, inputRequests.length, questionRequests.length])

  // 切换会话回到跟随态（不同会话的滚动位置无回看意义）；渲染期调整，避免 effect 级联
  const [prevActiveId, setPrevActiveId] = useState(activeId)
  if (prevActiveId !== activeId) {
    setPrevActiveId(activeId)
    setFollowing(true)
  }

  const handleSend = (text: string): void => {
    setFollowing(true)
    send(text)
  }

  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setFollowing(true)
  }

  /** 停跟随并滚到首个待人工处理项（审批或人工输入） */
  const jumpToApproval = (): void => {
    setFollowing(false)
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>('[data-approval-pending], [data-input-pending]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const handleNewSession = (): void => {
    void newSession()
    setView('chat')
  }

  return (
    <div className="flex h-full">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* 头部：聊天视图（← + 当前会话标题）/ 列表视图（所有会话）；右端恒为新建 */}
        <ActivityPanelHeader>
          {view === 'chat' && (
            <IconButton
              variant="toolbar"
              icon={ArrowLeft}
              size={13}
              frame={24}
              title={t('ai.backToList')}
              onClick={() => setView('list')}
            />
          )}
          {view === 'chat' && active?.titlePending && (
            <Loader2 size={12} className="shrink-0 animate-spin text-muted" />
          )}
          <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
            {view === 'chat'
              ? active
                ? sessionTitle(active)
                : t('ai.title')
              : t('ai.allSessions')}
          </span>
          <IconButton
            variant="toolbar"
            icon={Plus}
            size={12}
            frame={22}
            cornerRadius={11}
            filled
            aria-label={t('ai.newSession')}
            onClick={handleNewSession}
          />
        </ActivityPanelHeader>

        {view === 'list' ? (
          <SessionList
            sessions={sessions}
            activeId={activeId}
            onOpen={(id) => {
              activate(id)
              setView('chat')
            }}
            onClose={closeSession}
          />
        ) : active ? (
          <>
            {/* 消息列表（滚动跟随：following=false 时不再贴底）；待审批内嵌在对应工具卡内 */}
            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                className="h-full overflow-y-auto px-4 py-3"
                onScroll={() => {
                  const el = scrollRef.current
                  if (!el) return
                  const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD
                  setFollowing(near)
                }}
              >
                {active.messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted">
                    <Bot size={28} strokeWidth={1.6} />
                    <span className="text-body">{t('ai.empty')}</span>
                    <span className="text-caption">{t('ai.emptyHint')}</span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {active.messages.map((m) => (
                      <MessageItem key={m.id} m={m} sessionId={active.id} />
                    ))}
                    {/* 处理指示器：agent 思考/调用工具中（后台命令运行由光圈表达，不在此重复） */}
                    {(active.stopping ||
                      active.status === 'submitted' ||
                      active.status === 'streaming') && (
                      <div className="flex items-center gap-1.5 text-caption text-muted">
                        <Loader2 size={11} className="animate-spin" />
                        {t(active.stopping ? 'ai.stopping' : 'ai.processing')}
                      </div>
                    )}
                    {active.error &&
                      !active.messages.some(
                        (m) =>
                          m.metadata?.error === active.error?.message ||
                          m.parts.some(
                            (p) =>
                              isToolUIPart(p) &&
                              p.state === 'output-error' &&
                              p.errorText.includes(active.error!.message)
                          )
                      ) && (
                        <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-body text-danger">
                          {active.error.message}
                        </p>
                      )}
                    {/* 人工输入卡片：排在对话末尾（agent 提示之后），与 VS Code 提问卡同位 */}
                    {questionRequests.map((request) => (
                      <QuestionCard key={request.toolCallId} request={request} />
                    ))}
                    {inputRequests.map((request) => (
                      <HumanInputCard key={request.executionId} request={request} />
                    ))}
                  </div>
                )}
              </div>
              {/* 上翻离底时出现；点击平滑回底并恢复跟随 */}
              {!following && (
                <button
                  type="button"
                  onClick={jumpToBottom}
                  aria-label={t('ai.backToBottom')}
                  title={t('ai.backToBottom')}
                  className="absolute bottom-3 right-4 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-raised text-muted shadow-md transition-colors hover:text-fg"
                >
                  <ArrowDown size={13} strokeWidth={2.2} />
                </button>
              )}
            </div>

            {/* 输入区（多行 + /命令 + @主机；发送/停止按钮由 Composer 持有） */}
            <div className="shrink-0 border-t border-chrome-sep p-3">
              <ChatComposer
                key={active.id}
                sessionId={active.id}
                busy={isBusy(active)}
                disabled={!active.loaded || active.id.startsWith('pending:')}
                placeholder={t('ai.placeholder')}
                onSend={handleSend}
                onCancel={cancel}
                onViewApprovals={jumpToApproval}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-muted">
            <Bot size={28} strokeWidth={1.6} />
            <span className="text-body">{t('ai.loading')}</span>
            {initError && (
              <span className="max-w-md text-center text-caption text-danger">{initError}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default AiWorkspacePage
