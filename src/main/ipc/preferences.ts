import { ipcMain } from 'electron'
import { clampUiScale } from '../../shared/prefs'
import type { AppPreferencesData } from '../../shared/types'
import * as prefs from '../data/prefs'
import { setPrefsNotifier } from '../data/prefs'
import { perfRescan } from '../ssh/perfHub'
import { channels } from './channels'
import { broadcast } from './delivery'
import { parseInput, preferencesSchema } from './validation'

export function registerPreferencesIpc(): void {
  // prefs 权威同步：main 侧任意写入（模型缓存等）广播最新偏好到所有窗口
  setPrefsNotifier((p) => {
    broadcast('prefs:changed', p)
  })
  ipcMain.handle(channels.prefsGet, (): AppPreferencesData => prefs.getPreferences())

  ipcMain.handle(channels.prefsSet, (event, input: unknown): AppPreferencesData => {
    const patch = parseInput(preferencesSchema, input)
    const next = prefs.setPreferences(patch)
    // UI 缩放：落库即套用到发起窗口（渲染层同步按新比例反算终端字号）
    if (patch.uiScale !== undefined) event.sender.setZoomFactor(clampUiScale(next.uiScale) / 100)
    // 全局监控开关变更 → 立即按新偏好重扫（关 = 释放探测连接，开 = 补建）
    if (patch.perfMonitorDisabled !== undefined) perfRescan()
    return next
  })
}
