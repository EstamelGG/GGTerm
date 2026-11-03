import { create } from 'zustand'
import type { AppPreferencesData } from '@shared/types'
import { AI_DEFAULTS } from '@shared/ai'
import { applyAccent, applyBgTransparency, applyUiScale } from '@/lib/accent'
import { applyTerminalFontSize } from '@/terminal/registry'
import { useWorkspaceIssues } from './workspaceIssues'

const writeVersions = new Map<string, number>()

/**
 * 应用偏好（全局单例）：App 启动拉取一次；模型切换器与设置弹窗共用同一份数据。
 * update = 本地即时生效（accent 实时预览）+ 持久化；语言走专属通道（主进程换语言并广播）。
 */
interface PrefsState {
  data: AppPreferencesData | null
  load: () => Promise<void>
  update: (patch: Partial<AppPreferencesData>) => void
}

export const usePrefsStore = create<PrefsState>((set, get) => ({
  data: null,

  load: async () => {
    const p = await window.aterm.prefs.get()
    set({ data: p })
  },

  update: (patch) => {
    const prev = get().data
    set({
      data: {
        ...(prev ?? {
          confirmCloseSession: true,
          accentHex: '#37A563',
          locale: 'auto' as const,
          perfMonitorDisabled: false,
          bgTransparency: 100,
          uiScale: 100,
          terminalFontSize: 12,
          localShell: '',
          ai: AI_DEFAULTS
        }),
        ...patch
      }
    })
    if (patch.accentHex) applyAccent(patch.accentHex)
    if (patch.bgTransparency !== undefined) applyBgTransparency(patch.bgTransparency)
    if (patch.uiScale !== undefined) applyUiScale(patch.uiScale)
    if (patch.terminalFontSize !== undefined) applyTerminalFontSize(patch.terminalFontSize)
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      const version = (writeVersions.get(key) ?? 0) + 1
      writeVersions.set(key, version)
      const scope = `preferences:save:${key}`
      useWorkspaceIssues.getState().clear(scope)
      const save = async (): Promise<void> => {
        if (writeVersions.get(key) !== version) return
        try {
          if (key === 'locale')
            await window.aterm.locale.apply(value as AppPreferencesData['locale'])
          else await window.aterm.prefs.set({ [key]: value })
          if (writeVersions.get(key) === version) useWorkspaceIssues.getState().clear(scope)
        } catch (error) {
          if (writeVersions.get(key) === version)
            useWorkspaceIssues.getState().report(scope, error, 'preferences', save)
        }
      }
      void save()
    }
  }
}))

// main 侧写入（模型缓存刷新等）经 prefs:changed 广播 → 权威数据替换本地镜像。
// 本地 update 的乐观 set 与随后到达的广播内容一致，不会回环（收到广播不再回写）。
// 防御：preload 加载失败时 window.aterm 缺失，不应阻塞整个渲染层初始化（App 内有兜底 UI）
try {
  window.aterm.prefs.onChanged((p) => {
    const prev = usePrefsStore.getState().data
    usePrefsStore.setState({ data: p })
    // 主题色可能由 main 侧迁移/同步更新，跟随刷新
    if (p.accentHex && p.accentHex !== prev?.accentHex) applyAccent(p.accentHex)
    if (p.bgTransparency !== undefined && p.bgTransparency !== prev?.bgTransparency)
      applyBgTransparency(p.bgTransparency)
    // UI 缩放：页面缩放由 main 侧套用（本窗口落库路径已自行套用），这里只同步终端字号
    if (p.uiScale !== undefined && p.uiScale !== prev?.uiScale) applyUiScale(p.uiScale)
    if (p.terminalFontSize !== undefined && p.terminalFontSize !== prev?.terminalFontSize)
      applyTerminalFontSize(p.terminalFontSize)
  })
} catch {
  /* preload 不可用时静默：load() 轮询路径仍可用 */
}
