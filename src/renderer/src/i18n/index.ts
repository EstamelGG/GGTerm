import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import enJson from './en.json'
import zhJson from './zh-CN.json'

/**
 * 渲染层 i18n：单一 'ui' 命名空间，en/zh-CN 两本词典，英文兜底。
 * 初始语言由主进程解析（prefs.locale，auto 跟随系统）；切换经 locale:changed 广播。
 * zhCN 以 `typeof en` 约束 —— 两侧 key 不一致直接编译报错。
 */
const en = enJson
const zhCN: typeof en = zhJson

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'ui'
    resources: { ui: typeof en }
  }
}

/** React 渲染前调用（main.tsx）；内联资源 init 同步就绪 */
export async function initI18n(): Promise<void> {
  const { locale } = await window.aterm.locale.get()
  await i18next.use(initReactI18next).init({
    lng: locale,
    fallbackLng: 'en',
    defaultNS: 'ui',
    resources: {
      en: { ui: en },
      'zh-CN': { ui: zhCN }
    },
    interpolation: { escapeValue: false }, // React 已防注入
    react: { useSuspense: false }
  })
  window.aterm.locale.onChanged(({ locale: next }) => {
    void i18next.changeLanguage(next)
  })
}
