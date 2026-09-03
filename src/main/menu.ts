import { BrowserWindow, Menu } from 'electron'
import { t } from './i18n'
import { stepTerminalFont } from './terminalFont'

/** 对照 Swift 版 CommandGroup(replacing: .newItem)：移除「新建」项，Cmd+N 无效 */
export function installMenu(): void {
  // 不放空 submenu（macOS 上空菜单会持续触发 representedObject 告警）；
  // 整个模板未注册 newItem，Cmd+N 无绑定，与 Swift 版一致
  const focused = (): Electron.WebContents | undefined =>
    (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      role: 'viewMenu',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // 终端字号：加速键写在这里是为了「可被看见」——
        // macOS 上菜单先消费 CommandOrControl+Plus，渲染层收不到该按键，
        // 而 Cmd+= （不带 Shift）菜单不匹配，由渲染层的捕获监听兜底；两条路落到同一处步进
        {
          label: t('menu.terminalFontIncrease'),
          accelerator: 'CommandOrControl+Plus',
          click: () => stepTerminalFont(1)
        },
        {
          label: t('menu.terminalFontDecrease'),
          accelerator: 'CommandOrControl+-',
          click: () => stepTerminalFont(-1)
        },
        {
          label: t('menu.terminalFontReset'),
          accelerator: 'CommandOrControl+0',
          click: () => stepTerminalFont(0)
        },
        { type: 'separator' },
        {
          label: t('menu.logPanel'),
          accelerator: 'CommandOrControl+Shift+L',
          click: () => focused()?.send('app:open-logs')
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
