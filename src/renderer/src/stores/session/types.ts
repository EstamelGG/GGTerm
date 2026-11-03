import type { EncodingMode, FileEncoding } from '@shared/encoding'
import type {
  HostConnection,
  HostStateEvent,
  LinkPhase,
  SftpEntry,
  ShellStateEvent,
  ShellStatus
} from '@shared/types'
/** 对照 ATerminal-Swift SessionCenter.WorkspaceTab */
export type WorkspaceTab =
  | { kind: 'local' }
  | { kind: 'browser' }
  | { kind: 'connections' }
  | { kind: 'ai' }
  | { kind: 'host'; id: string }
  /** section：打开设置页时定位的分区（对话页「管理模型」等深链入口） */
  | { kind: 'settings'; section?: 'general' | 'host' | 'ai' | 'about' }
/** 对照 SSHTerminalController 镜像（进程与通道在主进程） */
export interface HostShell {
  id: string
  number: number
  status: ShellStatus
  error?: string
}

/** 对照 RemoteDocument：远程编辑文档（读写经 SFTP） */
export interface RemoteFileDoc {
  encoding: FileEncoding
  encodingMode: EncodingMode
  bom: boolean
  confidence: number
  readOnly: boolean
  id: string
  path: string
  name: string
  /** 远端文件大小（readForEdit 超限判断/下载入口用） */
  size: number
  text: string
  /** 上次保存内容；dirty = text !== saved */
  saved: string
  loading: boolean
  saving: boolean
  error: string | null
}

/** 手动登录勾选"保存"时暂存的凭据；connected 后落盘并清空 */
export interface PendingManualSecrets {
  authType: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
}

/** 对照 HostWorkspace 镜像：主机工作区渲染层状态 */
export interface HostWorkspaceMirror {
  viewerOnly?: boolean
  id: string
  conn: HostConnection
  title: string
  phase: LinkPhase
  attempt: number
  offlineReason: string
  awaiting: boolean
  pendingSecrets: PendingManualSecrets | null
  shells: HostShell[]
  focusShellId: string | null
  /** 上部编辑区打开的远程编辑文档（上下分栏：与 shell 区独立展示） */
  files: RemoteFileDoc[]
  focusFileId: string | null
}

export interface SessionState {
  tab: WorkspaceTab
  hosts: HostWorkspaceMirror[]
  setTab: (tab: WorkspaceTab) => void
  connect: (conn: HostConnection, enter?: boolean) => Promise<void>
  restoreViewer: (conn: HostConnection, focusShellId: string) => void
  closeHost: (id: string, agentConnectionIds?: string[]) => void
  detachHost: (id: string) => void
  addShell: (hostId: string, bootstrap?: string) => Promise<void>
  closeShell: (hostId: string, shellId: string) => void
  focusShell: (hostId: string, shellId: string) => void
  openFile: (hostId: string, entry: SftpEntry) => void
  saveFile: (hostId: string, fileId: string) => Promise<boolean>
  reloadFile: (hostId: string, fileId: string, encoding?: EncodingMode) => void
  closeFile: (hostId: string, fileId: string) => void
  focusFile: (hostId: string, fileId: string) => void
  setFileText: (hostId: string, fileId: string, text: string) => void
  reconnectHost: (hostId: string) => void
  reconnectShell: (hostId: string, shellId: string) => void
  submitAuth: (
    hostId: string,
    cred: {
      username: string
      password?: string
      privateKey?: string
      passphrase?: string
      persist?: boolean
    }
  ) => void
  applyHostState: (e: HostStateEvent) => void
  applyShellState: (e: ShellStateEvent) => void
}
