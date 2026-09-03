import { app, shell, BrowserWindow, nativeTheme, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { getPreferences } from './data/prefs'
import { initMainI18n } from './i18n'
import { installMenu } from './menu'
import { installTerminalFontKeys } from './terminalFont'
import { appLog } from './log'

// 进程级兜底：网络瞬断等场景的零星 socket 错误不应击穿为 Uncaught Exception
// 崩掉整个应用（终端/SFTP 会话全丢）。只记录不退出；真正的结构性错误仍会在日志中显现。
process.on('uncaughtException', (err) => {
  appLog('main', `Uncaught exception: ${err.stack ?? err.message}`, 'error')
})
process.on('unhandledRejection', (reason) => {
  appLog('main', `Unhandled promise rejection: ${String(reason)}`, 'error')
})

let quitRequested = false
app.on('before-quit', () => {
  quitRequested = true
})

function createWindow(): void {
  // 对照 ATerminal-Swift：默认 1200×780，最小 980×620，unifiedCompact 工具栏观感
  // 窗口级玻璃：macOS vibrancy / Win11 亚克力（配合渲染层表面色的半透明叠层透出壁纸）；
  // Linux 无对应材质，回退实色背景
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 620,
    show: false,
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    backgroundColor: isMac || isWin ? '#00000000' : '#121416',
    ...(isMac
      ? { vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const }
      : {}),
    ...(isWin ? { backgroundMaterial: 'acrylic' as const } : {}),
    title: 'GGTerm',
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // UI 缩放：创建窗口时即套用（避免首帧「100% → 保存值」的整窗尺寸跳变）
      zoomFactor: getPreferences().uiScale / 100,
      // 启动外观：创建窗口时同步读已存 accent / 背景透明度传给 preload，
      // 渲染层首帧前即设置 CSS 变量，避免「默认值 → 保存值」闪变
      additionalArguments: [
        `--pref-accent=${getPreferences().accentHex}`,
        `--pref-bg-transparency=${getPreferences().bgTransparency}`
      ]
    }
  })

  // 终端字号快捷键（Cmd/Ctrl +/-/0）：窗口级拦截，先于页面与 xterm 拿到按键
  installTerminalFontKeys(mainWindow)

  let closeReady = false
  let closeApproved = false
  const ready = (event: Electron.IpcMainEvent): void => {
    if (event.sender === mainWindow.webContents) closeReady = true
  }
  const approve = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== mainWindow.webContents) return
    closeApproved = true
    if (quitRequested) app.quit()
    else mainWindow.close()
  }
  ipcMain.on('app:close-ready', ready)
  ipcMain.on('app:confirm-close', approve)
  mainWindow.on('close', (event) => {
    if (!closeApproved && closeReady && !mainWindow.webContents.isDestroyed()) {
      event.preventDefault()
      mainWindow.webContents.send('app:request-close')
    }
  })
  mainWindow.on('closed', () => {
    ipcMain.removeListener('app:close-ready', ready)
    ipcMain.removeListener('app:confirm-close', approve)
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })
  // 开发期把渲染层 console 转发到终端，便于排障
  if (is.dev) {
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[renderer] ${event.message} ${event.sourceId ?? ''}`)
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const protocol = new URL(details.url).protocol
      if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(details.url)
    } catch {
      /* ignore invalid URLs */
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.estamelgg.ggterm')

  // 应用强制深色：固定原生主题外观，vibrancy 等原生材质才会用深色渲染
  // （否则跟随系统浅色模式，材质呈浅灰，压不住半透明叠层）
  nativeTheme.themeSource = 'dark'

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initMainI18n()
  installMenu()
  registerIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', (event) => {
  // 无外部子进程需要优雅停止（copilot runtime 已移除）；挂起审批随进程结束由拒绝语义结算
  event.preventDefault()
  app.exit(0)
})
