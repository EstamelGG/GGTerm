import { create } from 'zustand'
import i18next from 'i18next'
import { AbstractChat, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
import type { ChatState, ChatStatus, ChatTransport, UIMessageChunk } from 'ai'
import { buildPayload } from '@/lib/aiInput'
import { useConnectionsStore } from '@/stores/connections'
import { useLinksStore } from '@/stores/links'
import type { AiEvent, AiSessionSummary, AiUIMessage } from '@shared/types'

/**
 * AI 多会话渲染层状态：每会话一个 AI SDK Chat（AbstractChat），状态直接落在 zustand（ChatState 适配），
 * 传输层为 IPC（main 运行 ToolLoopAgent，流片经 ai:event 广播）。审批 = SDK 工具审批：
 * addToolApprovalResponse 写回消息，sendAutomaticallyWhen 自动续跑。
 */

export interface AiSession {
  id: string
  title: string
  /** 会话创建/最近活动时间（列表展示与排序用） */
  createdAt: number
  updatedAt: number
  messages: AiUIMessage[]
  status: ChatStatus
  error?: Error
  /** 历史是否已从 main 水合 */
  loaded: boolean
  /** 标题生成中（main 经 title-pending 事件同步）：UI 在标题位置显示转圈 */
  titlePending?: boolean
}

interface AiState {
  sessions: AiSession[]
  activeId: string | null
  initError: string | null
  /** 跨页面入口（主机备注「Agent 代填」等）：新建会话并直接发送，不经输入框、不需人工确认 */
  sendInNewSession: (text: string) => Promise<void>
  /** 要求切回对话视图的信号（自增计数，对话页判重消费一次）：列表视图下看不到刚发起的对话 */
  viewChatRequest: number
  init: () => Promise<void>
  newSession: () => Promise<void>
  closeSession: (id: string) => void
  activate: (id: string) => void
  send: (text: string) => void
  cancel: () => void
  respondApproval: (sessionId: string, approvalId: string, approved: boolean, note?: string) => void
  applyEvent: (e: AiEvent) => void
}

/* ---------------- 派生量 ---------------- */

/** 末条 assistant 消息里等待人工审批的工具块（自动审批 isAutomatic 不算） */
export function pendingApprovals(
  messages: AiUIMessage[]
): { approvalId: string; toolCallId: string }[] {
  const last = messages.at(-1)
  if (last?.role !== 'assistant') return []
  return last.parts.flatMap((p) =>
    isToolUIPart(p) && p.state === 'approval-requested' && !p.approval?.isAutomatic
      ? [{ approvalId: p.approval.id, toolCallId: p.toolCallId }]
      : []
  )
}

/** 会话是否忙：生成中，或末条消息有待审批（审批未决时不得开启新回合） */
export function isBusy(s: Pick<AiSession, 'status' | 'messages'>): boolean {
  return s.status !== 'ready' || pendingApprovals(s.messages).length > 0
}

/** 消息纯文本（用户消息优先原文 display） */
export function textOf(m: AiUIMessage): string {
  return m.metadata?.display ?? m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** 会话标题：main 自动标题优先，回退首条用户消息截断；空会话显示「新对话」。 */
export function sessionTitle(s: { title: string; messages: AiUIMessage[] }): string {
  if (s.title.trim()) return s.title
  const first = s.messages.find((m) => m.role === 'user' && textOf(m).trim())
  if (!first) return i18next.t('ai.newSession')
  const text = textOf(first).trim().replace(/\s+/g, ' ')
  return text.length > 20 ? `${text.slice(0, 20)}…` : text
}

/* ---------------- IPC 传输层 ---------------- */

/** 进行中回合的接收端：main 按会话广播流片，渲染层持有的流是唯一消费者 */
interface Receiver {
  ctrl: ReadableStreamDefaultController<UIMessageChunk>
}
const receivers = new Map<string, Receiver>()

function openStream(sessionId: string): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start: (ctrl) => {
      receivers.set(sessionId, { ctrl })
    },
    cancel: () => {
      receivers.delete(sessionId)
    }
  })
}

function deliver(r: Receiver, sessionId: string, e: AiEvent): void {
  if (e.type === 'chunk') {
    r.ctrl.enqueue(e.chunk)
  } else if (e.type === 'turn-end') {
    receivers.delete(sessionId)
    r.ctrl.close()
  }
}

const transport: ChatTransport<AiUIMessage> = {
  async sendMessages({ chatId, messages, abortSignal }) {
    const stream = openStream(chatId)
    abortSignal?.addEventListener('abort', () => window.aterm.ai.cancel(chatId))
    try {
      await window.aterm.ai.run(chatId, messages)
    } catch (err) {
      receivers.delete(chatId)
      throw err
    }
    return stream
  },
  /** 不做流片重放：重载期间若回合仍在跑，由 turn-end 事件触发水合补齐（见 applyEvent） */
  async reconnectToStream() {
    return null
  }
}

/* ---------------- Chat（每会话） ---------------- */

/**
 * AbstractChat 流式写入时原地改 message.parts；MessageItem 又是 memo，必须发布新身份
 * 才能触发重渲染。只浅拷贝 message / parts / 各 part / metadata，嵌套 tool output 共享引用
 * （与 @ai-sdk/react 的做法一致，避免每 chunk structuredClone 二次方开销）。
 */
function publishMessage(m: AiUIMessage): AiUIMessage {
  return {
    ...m,
    ...(m.metadata != null ? { metadata: { ...m.metadata } } : null),
    parts: m.parts.map((p) => ({ ...p }))
  }
}

/** zustand 适配的 ChatState：Chat 的消息/状态直接写入对应会话 */
class SessionChatState implements ChatState<AiUIMessage> {
  constructor(private readonly id: string) {}
  private get s(): AiSession | undefined {
    return useAiStore.getState().sessions.find((x) => x.id === this.id)
  }
  private patch(p: Partial<AiSession>): void {
    useAiStore.setState((st) => ({
      sessions: patchSession(st.sessions, this.id, (s) => ({ ...s, ...p }))
    }))
  }
  get status(): ChatStatus {
    return this.s?.status ?? 'ready'
  }
  set status(status: ChatStatus) {
    this.patch({ status })
  }
  get error(): Error | undefined {
    return this.s?.error
  }
  set error(error: Error | undefined) {
    this.patch({ error })
  }
  get messages(): AiUIMessage[] {
    return this.s?.messages ?? []
  }
  set messages(messages: AiUIMessage[]) {
    this.patch({ messages })
  }
  pushMessage = (m: AiUIMessage): void =>
    this.patch({ messages: [...this.messages, publishMessage(m)] })
  popMessage = (): void => this.patch({ messages: this.messages.slice(0, -1) })
  replaceMessage = (i: number, m: AiUIMessage): void =>
    this.patch({
      messages: this.messages.map((x, j) => (j === i ? publishMessage(m) : x))
    })
  snapshot = <T>(t: T): T => structuredClone(t)
}

class SessionChat extends AbstractChat<AiUIMessage> {}

const chats = new Map<string, SessionChat>()
/** 会话忙时到达的执行器通知，空闲后依次投递 */
const pendingNotify = new Map<string, string[]>()

function chatOf(id: string): SessionChat {
  let chat = chats.get(id)
  if (chat) return chat
  chat = new SessionChat({
    id,
    transport,
    state: new SessionChatState(id),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      useAiStore.setState((st) => ({
        sessions: patchSession(st.sessions, id, (s) => ({ ...s, updatedAt: Date.now() }))
      }))
      // 回合收尾以 main 持久化结果为准（中断的工具卡已标记、审批续跑后消息完整）
      void hydrate(id, true)
    }
  })
  chats.set(id, chat)
  return chat
}

function flushNotify(id: string): void {
  const s = useAiStore.getState().sessions.find((x) => x.id === id)
  const queue = pendingNotify.get(id)
  if (!s || !queue?.length || isBusy(s)) return
  void chatOf(id).sendMessage({ text: queue.shift()!, metadata: { createdAt: Date.now() } })
}

/* ---------------- store ---------------- */

function emptySession(summary: AiSessionSummary): AiSession {
  return { ...summary, messages: [], status: 'ready', loaded: false }
}

/** 组装并投递给指定会话：UI 显示用户原文（metadata.display），正文为经提示词层变换的 payload */
function dispatch(id: string, text: string): void {
  const conns = useConnectionsStore.getState().connections
  const phases = useLinksStore.getState().byHost
  const payload = buildPayload(
    text,
    conns.map((c) => ({ conn: c, phase: phases[c.id]?.phase })),
    i18next.t
  )
  void chatOf(id).sendMessage({ text: payload, metadata: { createdAt: Date.now(), display: text } })
}

function patchSession(
  list: AiSession[],
  id: string,
  patch: (s: AiSession) => AiSession
): AiSession[] {
  return list.map((s) => (s.id === id ? patch(s) : s))
}

/** 从 main 拉取历史（首次激活 / 回合结束 / 重载后补齐） */
async function hydrate(id: string, force = false): Promise<void> {
  const target = useAiStore.getState().sessions.find((s) => s.id === id)
  if (!target || (target.loaded && !force)) return
  try {
    const messages = await window.aterm.ai.getMessages(id)
    const cur = useAiStore.getState().sessions.find((s) => s.id === id)
    if (!cur || cur.status !== 'ready') return
    useAiStore.setState((st) => ({
      sessions: patchSession(st.sessions, id, (s) => ({ ...s, messages, loaded: true }))
    }))
    // 水合即全部：进行中的回合结束后由 turn-end 事件触发再次水合补齐
    flushNotify(id)
  } catch {
    /* 水合失败保持现有镜像，发送时会有明确报错 */
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  sessions: [],
  activeId: null,
  initError: null,
  viewChatRequest: 0,

  init: async () => {
    // 幂等：AI 工作台是条件挂载（切 tab 会卸载重挂），镜像已存在则不重建
    if (get().sessions.length > 0) return
    try {
      let list = await window.aterm.ai.listSessions()
      if (list.length === 0) list = [await window.aterm.ai.createSession()]
      set({ sessions: list.map(emptySession), activeId: list[0].id, initError: null })
      void hydrate(list[0].id)
    } catch (err) {
      set({
        initError: String(err instanceof Error ? err.message : err),
        sessions: [],
        activeId: null
      })
    }
  },

  newSession: async () => {
    // 已有完全空会话（无标题、无消息、不忙）时直接进入，避免堆积空会话；
    // 必须限定 loaded：重启后未水合的会话镜像 messages 恒为 []（标题也可能未生成），
    // 不能据此判定为空，否则会误跳到旧会话
    const empty = get().sessions.find(
      (s) => s.loaded && !s.title.trim() && s.messages.length === 0 && !isBusy(s)
    )
    if (empty) {
      if (empty.id !== get().activeId) get().activate(empty.id)
      return
    }
    // 乐观切换：createSession 的 IPC 往返需几百 ms，期间先渲染占位空会话
    const prevActiveId = get().activeId
    const pendingId = `pending:${Date.now()}`
    const now = Date.now()
    set((state) => ({
      sessions: [
        ...state.sessions,
        {
          ...emptySession({ id: pendingId, title: '', createdAt: now, updatedAt: now }),
          loaded: true
        }
      ],
      activeId: pendingId
    }))
    try {
      const s = await window.aterm.ai.createSession()
      set((state) => ({
        sessions: state.sessions.map((x) =>
          x.id === pendingId ? { ...emptySession(s), loaded: true } : x
        ),
        activeId: state.activeId === pendingId ? s.id : state.activeId,
        initError: null
      }))
    } catch (err) {
      set((state) => ({
        sessions: state.sessions.filter((x) => x.id !== pendingId),
        activeId: state.activeId === pendingId ? prevActiveId : state.activeId,
        initError: String(err instanceof Error ? err.message : err)
      }))
    }
  },

  closeSession: (id) => {
    window.aterm.ai.closeSession(id)
    chats.delete(id)
    pendingNotify.delete(id)
    const sessions = get().sessions.filter((s) => s.id !== id)
    if (sessions.length === 0) {
      void window.aterm.ai
        .createSession()
        .then((s) => set({ sessions: [{ ...emptySession(s), loaded: true }], activeId: s.id }))
        .catch((err: unknown) => {
          set({
            initError: String(err instanceof Error ? err.message : err),
            sessions: [],
            activeId: null
          })
        })
      return
    }
    set({
      sessions,
      // 列表按 updatedAt 降序（最新在前）：关掉当前会话后回到最近的那个，而不是列表末位的最老会话
      activeId: get().activeId === id ? sessions[0].id : get().activeId
    })
  },

  activate: (id) => {
    set({ activeId: id })
    void hydrate(id)
  },

  send: (text) => {
    const id = get().activeId
    const trimmed = text.trim()
    if (!id || !trimmed) return
    dispatch(id, trimmed)
  },

  /**
   * 新建会话并直接发送（主机备注「Agent 代填」等页面外入口）：不经输入框、不需人工确认。
   * 与 newSession 同策略——已有完全空的会话先复用，避免堆积空会话。
   */
  sendInNewSession: async (text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // 先举旗让对话页切回对话视图（列表视图下消息发出去也看不到）；页面未挂载过则本就默认对话视图
    set((s) => ({ viewChatRequest: s.viewChatRequest + 1 }))
    // 对话页可能还没挂载过：先水合镜像，空会话复用判断才可靠（已水合则立即返回）
    await get().init()
    const empty = get().sessions.find(
      (s) => s.loaded && !s.title.trim() && s.messages.length === 0 && !isBusy(s)
    )
    if (empty) {
      get().activate(empty.id)
      dispatch(empty.id, trimmed)
      return
    }
    try {
      const s = await window.aterm.ai.createSession()
      set((state) => ({
        sessions: [...state.sessions, { ...emptySession(s), loaded: true }],
        activeId: s.id,
        initError: null
      }))
      dispatch(s.id, trimmed)
    } catch (err) {
      // 建会话失败：不改 activeId，错误由对话页空态展示
      set({ initError: String(err instanceof Error ? err.message : err) })
    }
  },

  cancel: () => {
    const id = get().activeId
    if (!id) return
    const chat = chatOf(id)
    // 中断进行中的流；若卡在人工审批（回合已结束），一律按拒绝写回并触发续跑收尾
    void chat.stop()
    for (const p of pendingApprovals(get().sessions.find((s) => s.id === id)?.messages ?? [])) {
      void chat.addToolApprovalResponse({ id: p.approvalId, approved: false })
    }
  },

  respondApproval: (sessionId: string, approvalId: string, approved: boolean, note?: string) => {
    void chatOf(sessionId).addToolApprovalResponse({
      id: approvalId,
      approved,
      // 拒绝备注（SDK 原生 reason 字段）：随拒绝结果回传模型，供其调整后续方案
      ...(note ? { reason: note } : {})
    })
  },

  applyEvent: (e) => {
    if (e.type === 'chunk' || e.type === 'turn-end') {
      const r = receivers.get(e.sessionId)
      // 无接收端（渲染层重载后回合仍在跑）：以 main 的持久化结果为准补齐
      if (r) deliver(r, e.sessionId, e)
      else if (e.type === 'turn-end') void hydrate(e.sessionId, true)
      return
    }
    if (e.type === 'title') {
      set((s) => ({
        sessions: patchSession(s.sessions, e.sessionId, (x) => ({ ...x, title: e.title }))
      }))
      return
    }
    // 标题生成状态：会话标题位置显示转圈
    if (e.type === 'title-pending') {
      set((s) => ({
        sessions: patchSession(s.sessions, e.sessionId, (x) => ({ ...x, titlePending: e.pending }))
      }))
      return
    }
    // 执行器通知：以用户消息投递给 agent；会话忙（生成中/审批未决）则排队
    const list = pendingNotify.get(e.sessionId) ?? []
    list.push(e.text)
    pendingNotify.set(e.sessionId, list)
    flushNotify(e.sessionId)
  }
}))
