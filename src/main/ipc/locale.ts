import { ipcMain } from 'electron'
import type { LocalePref } from '../../shared/types'
import * as prefs from '../data/prefs'
import { resolveLocale, setLocalePref, type AppLocale } from '../i18n'
import { installMenu } from '../menu'
import { channels } from './channels'
import { broadcast, runOneWay } from './delivery'
import { localeSchema, parseInput } from './validation'

// Serialize switches so a slower earlier change cannot overwrite a newer language.
let pending: Promise<unknown> = Promise.resolve()
function applyLocale(pref: LocalePref): Promise<{ pref: LocalePref; locale: AppLocale }> {
  const result = pending.then(async () => {
    const locale = await setLocalePref(pref)
    installMenu()
    broadcast('locale:changed', { locale })
    return { pref, locale }
  })
  pending = result.catch(() => {})
  return result
}

export function registerLocaleIpc(): void {
  /** 语言：get 返回偏好+生效值；set 写偏好 → 主进程换语言 → 重建菜单 → 广播所有窗口 */
  ipcMain.handle(channels.localeGet, (): { pref: LocalePref; locale: AppLocale } => ({
    pref: prefs.getPreferences().locale,
    locale: resolveLocale()
  }))
  ipcMain.handle(channels.localeSet, (_e, input: unknown) => {
    const pref = parseInput(localeSchema, input)
    // Legacy callers receive the immediate reply after the preference write.
    const result = setLocalePref(pref).then((locale) => {
      installMenu()
      broadcast('locale:changed', { locale })
    })
    runOneWay(channels.localeSet, () => result)
    return { pref, locale: resolveLocale() }
  })
  ipcMain.handle('locale:apply', (_e, input: unknown) =>
    applyLocale(parseInput(localeSchema, input))
  )
}
