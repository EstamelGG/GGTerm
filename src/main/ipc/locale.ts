import { BrowserWindow, ipcMain } from 'electron'
import type { LocalePref } from '../../shared/types'
import * as prefs from '../data/prefs'
import { resolveLocale, setLocalePref, type AppLocale } from '../i18n'
import { installMenu } from '../menu'
import { channels } from './channels'

export function registerLocaleIpc(): void {
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
}
