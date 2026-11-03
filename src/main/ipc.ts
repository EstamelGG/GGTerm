import { BrowserWindow, ipcMain } from 'electron'
import { clampUiScale } from '../shared/prefs'
import type { AiUIMessage, AppLogEntry, AppPreferencesData, LocalePref } from '../shared/types'
import * as ai from './ai/engine'
import { registerExecutionIpc } from './ai/executionIpc'
import { registerHumanInputIpc } from './ai/humanInputIpc'
import { registerQuestionIpc } from './ai/questionIpc'
import { getApiKey, setApiKey } from './data/aiSecrets'
import * as prefs from './data/prefs'
import { setPrefsNotifier } from './data/prefs'
import { resolveLocale, setLocalePref, type AppLocale } from './i18n'
import { appLog, clearLogs, getLogs } from './log'
import { installMenu } from './menu'
import { perfRescan } from './ssh/perfHub'

import { channels } from './ipc/channels'
import { registerConnectionIpc } from './ipc/connections'
import { registerPerformanceIpc } from './ipc/performance'
import { registerWorkspaceIpc } from './ipc/workspace'
export { channels } from './ipc/channels'

/** Application registration entry point; domain modules keep their existing wire contracts. */
export function registerIpc(): void {
  registerConnectionIpc()
  registerWorkspaceIpc()
  registerPerformanceIpc()
  registerExecutionIpc()
  // 人工输入（敏感提示）通道：与只读查看器 API 分开，密码只经此写入 PTY
  registerHumanInputIpc()
  registerQuestionIpc()
  // prefs 权威同步：main 侧任意写入（模型缓存等）广播最新偏好到所有窗口
  setPrefsNotifier((p) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('prefs:changed', p)
    }
  })
  ipcMain.handle(channels.prefsGet, (): AppPreferencesData => prefs.getPreferences())

  ipcMain.handle(
    channels.prefsSet,
    (event, patch: Partial<AppPreferencesData>): AppPreferencesData => {
      const next = prefs.setPreferences(patch)
      // UI 缩放：落库即套用到发起窗口（渲染层同步按新比例反算终端字号）
      if (patch.uiScale !== undefined) event.sender.setZoomFactor(clampUiScale(next.uiScale) / 100)
      // 全局监控开关变更 → 立即按新偏好重扫（关 = 释放探测连接，开 = 补建）
      if (patch.perfMonitorDisabled !== undefined) perfRescan()
      return next
    }
  )

  /** 语言：get 返回偏好+生效值；set 写偏好 → 主进程换语言 → 重建菜单 → 广播所有窗口 */
  ipcMain.handle(channels.localeGet, (): { pref: LocalePref; locale: AppLocale } => ({
    pref: prefs.getPreferences().locale,
    locale: resolveLocale()
  }))
  ipcMain.handle(channels.localeSet, (_e, pref: LocalePref) => {
    void (async () => {
      const locale = await setLocalePref(pref)
      installMenu() // 菜单 label 即时换语言
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('locale:changed', { locale })
      }
    })()
    return { pref, locale: resolveLocale() }
  })

  ///** 应用内日志：历史拉取 / 渲染层写入 / 清空 */
  ipcMain.handle(channels.appLogs, (): AppLogEntry[] => getLogs())

  ipcMain.on(
    channels.appLogPush,
    (_e, { category, message }: { category: string; message: string }) => {
      appLog(category, message)
    }
  )

  ipcMain.on(channels.appLogClear, () => clearLogs())

  /* ---------------- AI Agent（⑤） ---------------- */

  ipcMain.handle(channels.aiListSessions, () => ai.listSessions())

  ipcMain.handle(channels.aiCreateSession, () => ai.createSession())

  ipcMain.handle(channels.aiGetMessages, (_e, { sessionId }: { sessionId: string }) =>
    ai.getMessages(sessionId)
  )

  ipcMain.on(channels.aiCloseSession, (_e, { sessionId }: { sessionId: string }) => {
    void ai.closeSession(sessionId)
  })

  ipcMain.handle(
    channels.aiRun,
    (
      _e,
      {
        sessionId,
        messages,
        turnId
      }: { sessionId: string; messages: AiUIMessage[]; turnId: string }
    ) => ai.run(sessionId, messages, turnId)
  )

  ipcMain.handle(
    channels.aiCancel,
    (_e, { sessionId, turnId }: { sessionId: string; turnId?: string }) =>
      ai.cancel(sessionId, turnId)
  )

  ipcMain.handle(channels.aiListModels, (_e, { providerId }: { providerId: string }) =>
    ai.listModels(providerId)
  )

  ipcMain.handle(channels.aiHasApiKey, (_e, profileId: string) => Boolean(getApiKey(profileId)))

  ipcMain.handle(
    channels.aiSetApiKey,
    (_e, { profileId, apiKey }: { profileId: string; apiKey: string }) => {
      setApiKey(profileId, apiKey)
    }
  )
}
