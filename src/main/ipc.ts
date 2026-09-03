import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { resolve as resolvePath, sep as pathSep } from 'node:path'
import { errorMessage } from '../shared/error'
import type { EncodingMode, FileEncoding } from '../shared/encoding'
import { clampUiScale } from '../shared/prefs'
import type {
  AiUIMessage,
  AppLogEntry,
  AppPreferencesData,
  ConnectionSecrets,
  HostConnection,
  HostGroup,
  LocalePref,
  LocalSshKey,
  PerfSample,
  ServerNote,
  SftpEntry,
  SshConfigHost,
  SshConnectionSession
} from '../shared/types'
import * as connections from './data/connections'
import * as secrets from './data/secrets'
import * as prefs from './data/prefs'
import { appLog, clearLogs, getLogs } from './log'
import { setPrefsNotifier } from './data/prefs'
import { probeLatency, type ProbeTarget } from './probe'
import { sshTest, type SshTestInput } from './sshTest'
import { pickLocalPaths } from './ssh/sftp'
import { listLocalKeys, parseSshConfig, readLocalKey } from './ssh/localSsh'
import { openFolderPrivacySettings } from './localAccess'
import type { ProtectedFolder } from '../shared/localAccess'
import { resolveLocale, setLocalePref, type AppLocale } from './i18n'
import { installMenu } from './menu'
import { getOrCreateLink, getLink, removeLink, listLinks, probeLinksOsName } from './ssh/link'
import {
  listAgentConnections,
  closeAgentConnection,
  closeSelectedConnections
} from './ai/agentLinks'
import {
  perfSnapshotAll,
  perfWatch,
  perfRefreshAll,
  perfSetPaused,
  perfInvalidate,
  perfForget,
  perfRescan
} from './ssh/perfHub'
import { sessionPerfWatch } from './ssh/sessionPerf'
import * as ai from './ai/engine'
import { registerExecutionIpc } from './ai/executionIpc'
import { registerHumanInputIpc } from './ai/humanInputIpc'
import { getApiKey, setApiKey } from './data/aiSecrets'
import type { HostLinkEvents } from './ssh/link'
import type { SftpSession } from './ssh/sftp'

/** IPC 通道命名约定：<域>:<动作>；invoke 请求-响应 */
export const channels = {
  connList: 'conn:list',
  connCreate: 'conn:create',
  connUpdate: 'conn:update',
  connDelete: 'conn:delete',
  connSetNote: 'conn:setNote',
  groupList: 'group:list',
  groupCreate: 'group:create',
  groupUpdate: 'group:update',
  groupDelete: 'group:delete',
  secretsSave: 'secrets:save',
  secretsLoad: 'secrets:load',
  secretsDelete: 'secrets:delete',
  prefsGet: 'prefs:get',
  appLogs: 'app:logs',
  appLogPush: 'app:log-push',
  appLogClear: 'app:log-clear',
  prefsSet: 'prefs:set',
  localeGet: 'locale:get',
  localeSet: 'locale:set',
  probeLatency: 'probe:latency',
  sshTest: 'ssh:test',
  hostConnect: 'host:connect',
  linksList: 'links:list',
  osProbe: 'os:probe',
  hostSubmitAuth: 'host:submitAuth',
  hostReconnect: 'host:reconnect',
  hostRestart: 'host:restart',
  hostClose: 'host:close',
  shellCreate: 'shell:create',
  shellStart: 'shell:start',
  shellInput: 'shell:input',
  shellResize: 'shell:resize',
  shellClose: 'shell:close',
  shellRestart: 'shell:restart',
  sftpStart: 'sftp:start',
  sftpStop: 'sftp:stop',
  sftpList: 'sftp:list',
  sftpRealpath: 'sftp:realpath',
  sftpReadlink: 'sftp:readlink',
  sftpItemDetail: 'sftp:itemDetail',
  sftpExists: 'sftp:exists',
  sftpIsDirectory: 'sftp:isDirectory',
  sftpMkdir: 'sftp:mkdir',
  sftpTouch: 'sftp:touch',
  sftpRename: 'sftp:rename',
  sftpChmod: 'sftp:chmod',
  sftpReadForEdit: 'sftp:readForEdit',
  sftpWriteText: 'sftp:writeText',
  sftpRemove: 'sftp:remove',
  sftpDownload: 'sftp:download',
  sftpUpload: 'sftp:upload',
  sftpMeasure: 'sftp:measure',
  sftpMeasureCancel: 'sftp:measureCancel',
  sftpTransferCancel: 'sftp:transferCancel',
  sftpPickLocal: 'sftp:pickLocal',
  sftpRevealDownloads: 'sftp:revealDownloads',
  sftpRevealLocal: 'sftp:revealLocal',
  localAccessOpenSettings: 'localAccess:openSettings',
  perfSnapshot: 'perf:snapshot',
  perfWatch: 'perf:watch',
  perfRefresh: 'perf:refresh',
  perfSetPaused: 'perf:setPaused',
  perfWatchSession: 'perf:watchSession',
  localKeysList: 'localKeys:list',
  localKeysRead: 'localKeys:read',
  sshConfigParse: 'sshConfig:parse',
  aiListSessions: 'ai:listSessions',
  aiCreateSession: 'ai:createSession',
  aiGetMessages: 'ai:getMessages',
  aiCloseSession: 'ai:closeSession',
  aiRun: 'ai:run',
  aiCancel: 'ai:cancel',
  aiListModels: 'ai:listModels',
  aiHasApiKey: 'ai:hasApiKey',
  aiSetApiKey: 'ai:setApiKey'
} as const

/** 阶段② 接表单回填用：更新连接时顺带回填凭据 */
export function registerIpc(): void {
  registerExecutionIpc()
  // 人工输入（敏感提示）通道：与只读查看器 API 分开，密码只经此写入 PTY
  registerHumanInputIpc()
  // prefs 权威同步：main 侧任意写入（模型缓存等）广播最新偏好到所有窗口
  setPrefsNotifier((p) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('prefs:changed', p)
    }
  })
  ipcMain.handle(channels.connList, (): HostConnection[] => connections.listConnections())

  ipcMain.handle(
    channels.connCreate,
    (_e, input: Parameters<typeof connections.createConnection>[0]) =>
      connections.createConnection(input)
  )

  ipcMain.handle(
    channels.connUpdate,
    (_e, { id, patch }: { id: string; patch: Partial<HostConnection> }) => {
      const conn = connections.updateConnection(id, patch)
      perfInvalidate(id) // 编辑保存：清停等 + 按新配置重建条目（禁用/删除条目）
      return conn
    }
  )

  ipcMain.handle(channels.connDelete, (_e, id: string): boolean => {
    const ok = connections.deleteConnection(id)
    if (ok) {
      secrets.deleteSecrets(id)
      perfForget(id)
    }
    return ok
  })

  // 结构化备注：独立通道（全量替换，不触发 perfInvalidate——改备注不打断性能探测/连接）
  ipcMain.handle(channels.connSetNote, (_e, { id, note }: { id: string; note: ServerNote }) =>
    connections.setNote(id, note)
  )

  ipcMain.handle(channels.groupList, (): HostGroup[] => connections.listGroups())

  ipcMain.handle(channels.groupCreate, (_e, input: Parameters<typeof connections.createGroup>[0]) =>
    connections.createGroup(input)
  )

  ipcMain.handle(
    channels.groupUpdate,
    (_e, { id, patch }: { id: string; patch: Partial<HostGroup> }) =>
      connections.updateGroup(id, patch)
  )

  ipcMain.handle(channels.groupDelete, (_e, id: string) => connections.deleteGroup(id))

  ipcMain.handle(
    channels.secretsSave,
    (_e, { id, secrets: s }: { id: string; secrets: Partial<ConnectionSecrets> }) => {
      secrets.saveSecrets(id, s)
      perfInvalidate(id) // 凭据更新 → 重置性能探测条目
    }
  )

  ipcMain.handle(channels.secretsLoad, (_e, id: string): ConnectionSecrets =>
    secrets.loadSecrets(id)
  )

  ipcMain.handle(channels.secretsDelete, (_e, id: string) => secrets.deleteSecrets(id))

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

  ipcMain.handle(channels.perfSnapshot, (): Record<string, PerfSample> => perfSnapshotAll())

  /** ~/.ssh 集成：列私钥 / 读私钥 / 解析 config（导入编排在渲染层） */
  ipcMain.handle(channels.localKeysList, (): Promise<LocalSshKey[]> => listLocalKeys())
  ipcMain.handle(channels.localKeysRead, (_e, path: string): Promise<string> => readLocalKey(path))
  ipcMain.handle(channels.sshConfigParse, (): Promise<SshConfigHost[]> => parseSshConfig())

  // 连接列表页可见行集合全量同步（IntersectionObserver 驱动；diff 在 perfHub 内）
  ipcMain.on(channels.perfWatch, (_e, hostIds: string[]) => {
    perfWatch(Array.isArray(hostIds) ? hostIds : [])
  })

  // 性能列表头手动刷新：清熔断 + 立即采样
  ipcMain.on(channels.perfRefresh, () => {
    perfRefreshAll()
  })

  // 性能列隐藏（窄窗口）→ 暂停采样计时器（条目/连接/样本保留），恢复可见续跑
  ipcMain.on(channels.perfSetPaused, (_e, paused: boolean) => {
    perfSetPaused(paused === true)
  })

  // 会话页活动栏面板打开/关闭 → 独立会话采样（借用会话共享连接，与连接列表视口采样解耦）
  ipcMain.on(channels.perfWatchSession, (_e, hostId: unknown) => {
    sessionPerfWatch(typeof hostId === 'string' ? hostId : null)
  })

  ipcMain.on(
    channels.appLogPush,
    (_e, { category, message }: { category: string; message: string }) => {
      appLog(category, message)
    }
  )

  ipcMain.on(channels.appLogClear, () => clearLogs())

  ipcMain.handle(channels.probeLatency, (_e, targets: ProbeTarget[]) => probeLatency(targets))

  ipcMain.handle(channels.sshTest, (_e, input: SshTestInput) => sshTest(input))

  /** 主机链路事件转发器（固定回发起连接的 renderer） */
  const linkEvents = (sender: Electron.WebContents): HostLinkEvents => ({
    onHostState: (payload) => {
      if (!sender.isDestroyed()) sender.send('host:state', payload)
    },
    onShellState: (payload) => {
      if (!sender.isDestroyed()) sender.send('shell:state', payload)
    },
    onShellData: (payload) => {
      if (!sender.isDestroyed()) sender.send('shell:data', payload)
    },
    onShellAnnounce: (payload) => {
      if (!sender.isDestroyed()) sender.send('shell:announce', payload)
    },
    onSftpState: (payload) => {
      if (!sender.isDestroyed()) sender.send('sftp:state', payload)
    },
    onSftpTransfer: (payload) => {
      if (!sender.isDestroyed()) sender.send('sftp:transfer', payload)
    },
    onSftpMeasure: (payload) => {
      if (!sender.isDestroyed()) sender.send('sftp:measure', payload)
    }
  })

  ipcMain.handle(channels.linksList, () => listLinks())

  ipcMain.on(channels.osProbe, (_e, { hostIds }: { hostIds: string[] }) => {
    probeLinksOsName(hostIds)
  })

  ipcMain.handle(channels.hostConnect, (e, conn: HostConnection) => {
    const link = getOrCreateLink(conn, linkEvents(e.sender))
    if (!link.awaitingCredentials) link.start()
    link.emitCurrentState()
    return { awaiting: link.awaitingCredentials }
  })

  ipcMain.on(
    channels.hostSubmitAuth,
    (
      _e,
      {
        hostId,
        username,
        password,
        privateKey,
        passphrase
      }: {
        hostId: string
        username: string
        password?: string
        privateKey?: string
        passphrase?: string
      }
    ) => {
      const link = getLink(hostId)
      if (!link || !username.trim() || (!password && !privateKey)) return
      const conn = { ...link.connection, username: username.trim() }
      link.update(conn, {
        password: password ?? '',
        privateKey: privateKey ?? '',
        passphrase: passphrase ?? ''
      })
      link.start()
    }
  )

  ipcMain.on(channels.hostReconnect, (_e, hostId: string) => {
    getLink(hostId)?.start()
  })

  ipcMain.on(channels.hostRestart, (_e, hostId: string) => {
    getLink(hostId)?.restart()
  })

  ipcMain.handle('host:connectionSessions', (_e, hostIds: string[]) => {
    if (!Array.isArray(hostIds) || hostIds.some((id) => typeof id !== 'string'))
      throw new Error('Invalid hosts')
    return hostIds
      .flatMap<SshConnectionSession>((hostId) => {
        const link = getLink(hostId)
        return link
          ? [
              {
                hostId,
                connectionId: link.connectionId,
                owner: 'user' as const,
                shellCount: [...link.shells.values()].filter(
                  (shell) => shell.status === 'connected' || shell.status === 'connecting'
                ).length,
                phase: link.phase,
                since: link.phaseSince
              }
            ]
          : []
      })
      .concat(listAgentConnections().filter((item) => hostIds.includes(item.hostId)))
  })
  ipcMain.handle('agent:links', () => listAgentConnections())
  ipcMain.handle('host:closeConnections', (_e, hostId: string, ids: string[]) => {
    if (
      typeof hostId !== 'string' ||
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== 'string')
    )
      throw new Error('Invalid connection selection')
    // Match actual transport IDs, so a stale selection never closes a replacement connection.
    return closeSelectedConnections(hostId, ids)
  })
  ipcMain.on(channels.hostClose, (_e, hostId: string, agentConnectionIds?: string[]) => {
    if (typeof hostId !== 'string') return
    if (Array.isArray(agentConnectionIds)) {
      for (const id of agentConnectionIds)
        if (typeof id === 'string') closeAgentConnection(hostId, id)
    }
    removeLink(hostId)
  })

  ipcMain.handle(
    channels.shellCreate,
    (_e, { hostId, bootstrap }: { hostId: string; bootstrap?: string }) => {
      const link = getLink(hostId)
      if (!link) throw new Error('host not connected')
      const shell = link.addShell(bootstrap)
      return { shellId: shell.id }
    }
  )

  // 延迟启动协议：渲染层 xterm 实例/镜像就绪后请求开通道（fire-and-forget；主进程另有 3.5s 兜底）
  ipcMain.on(
    channels.shellStart,
    (_e, { hostId, shellId }: { hostId: string; shellId: string }) => {
      getLink(hostId)?.startShell(shellId)
    }
  )

  ipcMain.on(
    channels.shellInput,
    (_e, { hostId, shellId, data }: { hostId: string; shellId: string; data: string }) => {
      getLink(hostId)?.shells.get(shellId)?.write(data)
    }
  )

  ipcMain.on(
    channels.shellResize,
    (
      _e,
      {
        hostId,
        shellId,
        cols,
        rows
      }: { hostId: string; shellId: string; cols: number; rows: number }
    ) => {
      getLink(hostId)?.shells.get(shellId)?.resize(cols, rows)
    }
  )

  ipcMain.on(
    channels.shellClose,
    (_e, { hostId, shellId }: { hostId: string; shellId: string }) => {
      getLink(hostId)?.removeShell(shellId)
    }
  )

  ipcMain.on(
    channels.shellRestart,
    (_e, { hostId, shellId }: { hostId: string; shellId: string }) => {
      const shell = getLink(hostId)?.shells.get(shellId)
      shell?.start()
    }
  )

  /* ---------------- SFTP（阶段④，对照 SftpController 的 IPC 化） ---------------- */

  const sftpOf = (hostId: string): SftpSession => {
    const sftp = getLink(hostId)?.sftp
    if (!sftp) throw new Error('host not connected')
    return sftp
  }

  ipcMain.handle(channels.sftpStart, (_e, hostId: string) => sftpOf(hostId).start())

  ipcMain.on(channels.sftpStop, (_e, hostId: string) => {
    getLink(hostId)?.sftp.stop()
  })

  // 列目录失败（如权限不足）不再打断 UI：错误进日志面板，树内以红色占位行呈现
  ipcMain.handle(
    channels.sftpList,
    async (_e, { hostId, path }: { hostId: string; path: string }) => {
      try {
        return await sftpOf(hostId).list(path)
      } catch (err) {
        appLog('sftp', `List directory "${path}" failed: ${errorMessage(err)}`, 'error')
        throw err
      }
    }
  )

  ipcMain.handle(channels.sftpRealpath, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).realpath(path)
  )

  ipcMain.handle(channels.sftpReadlink, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).readlink(path)
  )

  ipcMain.handle(
    channels.sftpItemDetail,
    (_e, { hostId, path }: { hostId: string; path: string }) => sftpOf(hostId).itemDetail(path)
  )

  ipcMain.handle(channels.sftpExists, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).exists(path)
  )

  ipcMain.handle(
    channels.sftpIsDirectory,
    (_e, { hostId, path }: { hostId: string; path: string }) => sftpOf(hostId).isDirectory(path)
  )

  ipcMain.handle(channels.sftpMkdir, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).mkdir(path)
  )

  ipcMain.handle(channels.sftpTouch, (_e, { hostId, path }: { hostId: string; path: string }) =>
    sftpOf(hostId).touch(path)
  )

  ipcMain.handle(
    channels.sftpRename,
    (_e, { hostId, src, dest }: { hostId: string; src: string; dest: string }) =>
      sftpOf(hostId).rename(src, dest)
  )

  ipcMain.handle(
    channels.sftpChmod,
    (_e, { hostId, path, mode }: { hostId: string; path: string; mode: number }) =>
      sftpOf(hostId).chmod(path, mode)
  )

  ipcMain.handle(
    channels.sftpReadForEdit,
    (
      _e,
      {
        hostId,
        path,
        size,
        encoding
      }: { hostId: string; path: string; size: number; encoding?: EncodingMode }
    ) => sftpOf(hostId).readForEdit(path, size, encoding)
  )

  ipcMain.handle(
    channels.sftpWriteText,
    (
      _e,
      {
        hostId,
        path,
        text,
        encoding,
        bom
      }: { hostId: string; path: string; text: string; encoding?: FileEncoding; bom?: boolean }
    ) => sftpOf(hostId).writeText(path, text, encoding, bom)
  )

  ipcMain.handle(
    channels.sftpRemove,
    (_e, { hostId, entry }: { hostId: string; entry: SftpEntry }) => sftpOf(hostId).remove(entry)
  )

  // 传输为后台任务：进度/错误经 sftp:transfer 事件广播，invoke 立即返回
  ipcMain.handle(
    channels.sftpDownload,
    (_e, { hostId, entry }: { hostId: string; entry: SftpEntry }) => {
      void sftpOf(hostId)
        .download(entry)
        .catch(() => {})
    }
  )

  ipcMain.handle(
    channels.sftpUpload,
    (
      _e,
      { hostId, localPaths, destDir }: { hostId: string; localPaths: string[]; destDir: string }
    ) => {
      void sftpOf(hostId)
        .upload(localPaths, destDir)
        .catch(() => {})
    }
  )

  // 测量同后台：进度/结果经 sftp:measure 事件广播
  ipcMain.handle(channels.sftpMeasure, (_e, { hostId, path }: { hostId: string; path: string }) => {
    void sftpOf(hostId).measure(path)
  })

  ipcMain.on(channels.sftpMeasureCancel, (_e, hostId: string) => {
    getLink(hostId)?.sftp.abortMeasure()
  })

  // 取消对应传输的字节流和专用通道。
  ipcMain.on(
    'sftp:retryCleanup',
    (_e, { hostId, transferId }: { hostId: string; transferId: string }) => {
      void getLink(hostId)?.sftp.retryCleanup(transferId)
    }
  )
  ipcMain.on(
    channels.sftpTransferCancel,
    (_e, { hostId, transferId }: { hostId: string; transferId: string }) => {
      getLink(hostId)?.sftp.cancelTransfer(transferId)
    }
  )

  ipcMain.handle(channels.sftpPickLocal, (e, folders: boolean) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    return pickLocalPaths(folders, parent)
  })

  ipcMain.handle(channels.sftpRevealDownloads, () => {
    shell.openPath(app.getPath('downloads'))
  })

  ipcMain.handle(
    channels.sftpRevealLocal,
    (_e, { path, isDir }: { path: string; isDir: boolean }) => {
      const root = resolvePath(app.getPath('downloads'))
      const resolved = resolvePath(path)
      if (resolved !== root && !resolved.startsWith(root + pathSep)) {
        throw new Error('path must be under downloads')
      }
      // 文件：打开所在目录并选中该文件；目录：直接打开该目录
      return isDir ? shell.openPath(resolved) : shell.showItemInFolder(resolved)
    }
  )

  ipcMain.handle(channels.localAccessOpenSettings, (_e, folder: ProtectedFolder) => {
    openFolderPrivacySettings(folder)
  })

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
    (_e, { sessionId, messages }: { sessionId: string; messages: AiUIMessage[] }) =>
      ai.run(sessionId, messages)
  )

  ipcMain.on(channels.aiCancel, (_e, { sessionId }: { sessionId: string }) => {
    void ai.cancel(sessionId)
  })

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
