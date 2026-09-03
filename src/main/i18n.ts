import { app } from 'electron'
import i18next from 'i18next'
import type { LocalePref } from '../shared/types'
import { getPreferences, setPreferences } from './data/prefs'

/**
 * 主进程 i18n：菜单 + 终端 announce（写入 PTY 流的可见文案）。
 * 语言真源在 prefs（electron-store），auto 跟随 app.getLocale()，英文兜底；
 * 切换由 ipc locale:set 驱动（写偏好 → changeLanguage → 重建菜单 → 广播渲染层）。
 */

export type AppLocale = Exclude<LocalePref, 'auto'>

const en = {
  menu: {
    logPanel: 'Log Panel',
    terminalFontIncrease: 'Increase Terminal Font',
    terminalFontDecrease: 'Decrease Terminal Font',
    terminalFontReset: 'Reset Terminal Font'
  },
  announce: {
    channelTimeout: 'Timed out opening shell channel',
    reconnected: 'Reconnected',
    sessionEnded: 'Session ended',
    linkLost: 'Connection lost',
    linkClosed: 'Connection closed, waiting for manual reconnect',
    reconnecting: 'Reconnecting ({{attempt}}/{{total}})',
    offlineManual: 'Connection lost, waiting for manual reconnect'
  },
  localAccess: {
    folderDownloads: 'Downloads',
    folderDocuments: 'Documents',
    folderDesktop: 'Desktop',
    denied:
      'No permission to read the "{{folder}}" folder. Grant GGTerm access under System Settings → Privacy & Security → Files and Folders, then retry.',
    systemError: 'System error: {{message}}'
  }
}

const zhCN: typeof en = {
  menu: {
    logPanel: '日志面板',
    terminalFontIncrease: '增大终端字号',
    terminalFontDecrease: '减小终端字号',
    terminalFontReset: '重置终端字号'
  },
  announce: {
    channelTimeout: '终端通道建立超时',
    reconnected: '已重新连接',
    sessionEnded: '会话已结束',
    linkLost: '连接已断开',
    linkClosed: '连接已被断开，等待手动重连',
    reconnecting: '正在重连（{{attempt}}/{{total}}）',
    offlineManual: '连接已断线，等待手动重连'
  },
  localAccess: {
    folderDownloads: '下载',
    folderDocuments: '文稿',
    folderDesktop: '桌面',
    denied:
      '没有读取「{{folder}}」文件夹的权限。请到「系统设置 → 隐私与安全性 → 文件与文件夹」中允许 GGTerm 访问「{{folder}}」文件夹后重试。',
    systemError: '系统错误: {{message}}'
  }
}

/** 偏好 → 生效语言（auto = 系统 zh* → 中文，其余英文兜底） */
export function resolveLocale(): AppLocale {
  const pref = getPreferences().locale
  if (pref !== 'auto') return pref
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** whenReady 早期调用（菜单 label 依赖）；内联资源 init 同步就绪 */
export function initMainI18n(): void {
  void i18next.init({
    lng: resolveLocale(),
    fallbackLng: 'en',
    defaultNS: 'main',
    resources: {
      en: { main: en },
      'zh-CN': { main: zhCN }
    }
  })
}

/** 主进程取词（key 形如 'announce.reconnecting'） */
export function t(key: string, opts?: Record<string, unknown>): string {
  return i18next.t(key, opts) as string
}

export async function setLocalePref(pref: LocalePref): Promise<AppLocale> {
  setPreferences({ locale: pref })
  const locale = resolveLocale()
  if (i18next.language !== locale) await i18next.changeLanguage(locale)
  return locale
}
