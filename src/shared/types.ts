import type { FileEncoding } from './encoding'
import type { LocalAccessDenial } from './localAccess'
import type { UIMessage, UIMessageChunk } from 'ai'

/** 对照 ATerminal-Swift Models/HostConnection.swift 的 AuthType */
export type AuthType = 'password' | 'privateKey' | 'manual'

/** 连接记录（不含凭据；凭据经 safeStorage 单独存取） */
export interface HostConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  deviceType?: import('./device').DeviceType
  authType: AuthType
  groupId: string | null
  /** 连接超时（ms），默认 20000 */
  connectTimeout: number
  /** 仅允许现代密钥交换；默认关闭以自动兼容旧设备 */
  strictKex?: boolean
  /** 保活间隔（ms），默认 5000；0 = 关闭心跳 */
  keepaliveInterval: number
  /** 连接后初始执行命令（空 = 无；如 su - / cd /data / 加载环境） */
  initCommand: string
  /** 初始路径（空 = 家目录；终端 cd + SFTP 定位，支持 ~ 前缀） */
  initDir: string
  /** 禁用连接列表性能监控（不建后台探测连接） */
  perfDisabled: boolean
  /** 跳板链：有序的已保存主机 id（最外层在前，[A, B] 表示 A→B→本机）；扁平非递归，各跳自身的链在建链时被忽略 */
  jumpHostIds: string[]
  /** 结构化备注（AI 经 list_hosts(includeNote) 读取、edit_note 更新） */
  note?: ServerNote
  createdAt: number
  updatedAt: number
}

/** 主机分组（无限层级树，对照 HostGroup.swift） */
export interface HostGroup {
  id: string
  name: string
  parentId: string | null
  /** #RRGGBB，默认 #FF7700 */
  colorHex: string
  /** 同级排序，小在前；相同时按名称 */
  sort: number
}

/** 结构化主机备注（平铺：顶层无嵌套对象容器，字段 = 标量或一层行数组；全字段可选 = 未设置。
 *  平铺保证 edit_note 的顶层字段级 patch 机制安全——传谁改谁，不存在部分嵌套覆盖丢字段） */
export interface ServerNote {
  /** 主机用途（一句话） */
  purpose?: string
  /** 其他网卡 IP 列表 */
  otherNics?: string[]
  /** 能否访问互联网（三态：undefined = 未设置） */
  internetAccess?: boolean
  /** 是否容器宿主（三态：undefined = 未设置） */
  containerEnabled?: boolean
  /** 容器列表 */
  containers?: { id?: string; name?: string }[]
  /** 本地镜像列表 */
  images?: { id?: string; name?: string }[]
  /** 性能：CPU 核数 */
  cpuCores?: number
  /** 性能：内存容量（如 8G） */
  memory?: string
  /** 性能：磁盘（如 500G SSD） */
  disk?: string
  /** 端口 → 服务名（如 { "0.0.0.0:8080": "官网" }） */
  openPorts?: Record<string, string>
  /** 主机上的服务 */
  services?: { name?: string; description?: string }[]
  /** 其他补充 */
  other?: string
}

/** 每连接凭据（对照 KeychainSecrets.ConnectionSecrets） */
export interface ConnectionSecrets {
  password: string
  privateKey: string
  passphrase: string
}

/** ~/.ssh 下的私钥文件（连接表单密钥选择器用） */
export interface LocalSshKey {
  name: string
  /** 绝对路径（readKey 入参） */
  path: string
}

/** ~/.ssh/config 解析出的主机条目（导入弹窗用） */
export interface SshConfigHost {
  /** Host 别名（导入后作连接名） */
  alias: string
  /** HostName；缺省回退别名本身 */
  host: string
  /** User；缺省回退本机用户名（OpenSSH 语义） */
  user: string
  port: number
  /** 首个 IdentityFile 的绝对路径；空 = 未配置 */
  identityFile: string
}

/** 应用语言（auto = 跟随系统） */
export type LocalePref = 'auto' | 'zh-CN' | 'en'

/** 偏好（对照 AppPreferences.swift；UserDefaults 两个 key） */
export interface AppPreferencesData {
  confirmCloseSession: boolean
  accentHex: string
  locale: LocalePref
  /** 全局关闭连接列表性能监控（不建任何后台探测连接） */
  perfMonitorDisabled: boolean
  /**
   * 背景透明度 0–100（设置 → 通用 → 主题色）：全局 in-flow 表面色沿「实 ←→ 透」轴平移。
   * 100 = 设计默认层次（窗口材质 vibrancy/亚克力隐约透出）；0 = 完全实色，挡掉窗口材质。
   * 悬浮层（.glass）、--at-hover、文本与分隔线不参与缩放，保证菜单/提示始终可读。
   */
  bgTransparency: number
  /**
   * UI 缩放百分比（设置 → 通用 → 界面缩放，5% 步进）：整体缩放应用界面（页面缩放，主进程执行）。
   * 终端字号在渲染层按 1/scale 反算抵消 —— 终端视觉字号与网格列数不随 UI 缩放变化。
   */
  uiScale: number
  /**
   * 终端字号（px，8–24）：Cmd +/- 步进、Cmd+0 复位到 12。
   * 终端屏幕视觉字号 = 该值（UI 缩放经 1/scale 反算抵消），与 UI 缩放正交。
   */
  terminalFontSize: number
  /** AI 配置（非密钥） */
  ai: AiConfig
}

/** 语言切换广播（locale:changed） */
export interface LocaleChangedEvent {
  /** 解析后的生效语言 */
  locale: Exclude<LocalePref, 'auto'>
}

/** 对照 HostLink.Phase */
export type LinkPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline'

/** 对照 SSHTerminalController.SessionStatus */
export type ShellStatus = 'connecting' | 'connected' | 'disconnected' | 'ended' | 'error'

export interface HostStateEvent {
  hostId: string
  phase: LinkPhase
  /** 进入当前 phase 的时刻（epoch ms）——状态时间事实来源，刷新后可续接倒计时 */
  since: number
  attempt?: number
  reason?: string
  awaiting?: boolean
  /** 拓扑图实际画边的跳板链（事实：已建立的链，拨号中为正在拨的链；非配置理论值） */
  jumpIds?: string[]
}

/** 链路状态快照（links:list）：拓扑图等视图的初始化数据源 */
export interface HostLinkSnapshot {
  hostId: string
  phase: LinkPhase
  since: number
  attempt?: number
  reason?: string
  /** 拓扑图实际画边的跳板链（同 HostStateEvent.jumpIds，事实而非配置） */
  jumpIds?: string[]
}

export interface ShellStateEvent {
  hostId: string
  shellId: string
  status: ShellStatus
  error?: string
}

export interface ShellDataEvent {
  hostId: string
  shellId: string
  data: string
}

export interface ShellAnnounceEvent {
  hostId: string
  shellId: string
  text: string
}

/* ---------------- SFTP（阶段④，对照 SftpController.swift） ---------------- */

/** 对照 SftpEntry.swift；时间为 epoch ms */
export interface SftpEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  permissions: number | null
  uid: number | null
  gid: number | null
  accessed: number | null
  modified: number | null
  longname: string
  linkTarget: string | null
}

export interface SftpListing {
  /** listDirectory 目标的 realpath（符号链接目录会解析成真实路径） */
  resolved: string
  entries: SftpEntry[]
}

/** 对照 SftpController.status + sessionReady */
export type SftpStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface SftpStateEvent {
  hostId: string
  status: SftpStatus
  error?: string
}

export type SftpTransferDirection = 'up' | 'down'
export type SftpTransferStatus = 'running' | 'done' | 'error' | 'canceled'

/** 应用内运行日志条目（主进程环形缓冲，菜单栏「日志面板」展示） */
export type AppLogLevel = 'info' | 'warning' | 'error'

export interface AppLogEntry {
  /** 毫秒时间戳 */
  t: number
  /** 分类（sftp / ssh / app …） */
  category: string
  message: string
  /** 级别（缺省视为 info；面板中 蓝/黄/红） */
  level?: AppLogLevel
}

/** 对照 SftpTransfer.swift（单条全量推送：创建/进度/终态） */
export interface SftpTransferMirror {
  id: string
  name: string
  direction: SftpTransferDirection
  status: SftpTransferStatus
  /** Cancel acknowledged; streams / partial files may still be cleaning up. */
  cancelRequested?: boolean
  phase?: 'downloading' | 'extracting'
  cleanup?: 'pending' | 'error'
  cleanupError?: string
  bytes: number
  total: number
  /** 瞬时速度（字节/秒），仅 running 进度事件携带 */
  speed?: number
  /** 已下载文件数（目录递归兜底下载用；无此字段=按字节进度） */
  files?: number
  /** 总文件数（目录递归兜底下载用） */
  totalFiles?: number
  error?: string
  /** 本机受保护目录权限不足（macOS 下载/文稿/桌面等） */
  accessDenied?: LocalAccessDenial
}

export interface SftpTransferEvent {
  hostId: string
  transfer: SftpTransferMirror
}

/** 目录测量进度（对照 SftpDirMeasure + measureDirectory 的 progress 回调） */
export interface SftpMeasureEvent {
  hostId: string
  path: string
  bytes: number
  files: number
  dirs: number
  /** 因权限等原因跳过的不可读子目录数（根目录不可读则整体报错，不走此计数） */
  skipped: number
  /** 被跳过目录的名称样本（最多前 5 个，用于提示"已跳过 'xxx' 等 N 个"） */
  skippedPaths: string[]
  done: boolean
  error?: string
}

/** 主机性能样本（连接列表页性能列；3s 轮询，仅已连接主机） */
export interface PerfSample {
  hostId: string
  /** CPU 逻辑核数 */
  cores: number
  /** CPU 使用率 0-100；首轮无差值基准时为 null */
  cpuPct: number | null
  /** 内存总量（字节）与"真占用"使用率（Total − Free − 缓存，与会话面板饼图同口径） */
  memTotal: number
  memPct: number
  /** 根分区总容量（字节）与使用率 */
  diskTotal: number
  diskPct: number
  /** swap 总量（字节）与使用率；无 swap 时 total=0/pct=null */
  swapTotal: number
  swapPct: number | null
  /** 网络上下行速率（字节/秒）；首轮无差值基准时为 null */
  netRx: number | null
  netTx: number | null
  /** 负载（/proc/loadavg 1/5/15 分钟）；缺失为 null */
  load1: number | null
  load5: number | null
  load15: number | null
  /** 进程数（运行中 / 总数，/proc/loadavg 第 4 字段）；缺失为 null */
  procsRun: number | null
  procsTotal: number | null
  /** 开机时长（秒，/proc/uptime）；缺失为 null */
  uptimeSec: number | null
  /** 发行版（/etc/os-release PRETTY_NAME），未知为空串 */
  osName: string
  /** 时区（Asia/Shanghai）；未知为空串 */
  timezone: string
  /** 内存空闲（字节，MemFree） */
  memFree: number
  /** 内存缓存（字节，Buffers + Cached + SReclaimable） */
  memCache: number
  /** 每逻辑核使用率 0-100（cpu0..cpuN-1）；首轮无差值基准时为空数组 */
  perCore: number[]
  /** 物理磁盘及其分区挂载点（lsblk 树 + df + /proc/diskstats） */
  disks: PerfDisk[]
  t: number
}

/** 磁盘分区挂载点（分区级；device 来自 df 的 Filesystem，其余来自 lsblk） */
export interface PerfDiskMount {
  /** 设备名（vda3） */
  device: string
  /** 挂载点路径（/、/boot/efi） */
  mount: string
  /** 文件系统类型（ext4 / xfs / vfat） */
  fstype: string
  /** 总量（字节） */
  size: number
  /** 已用（字节） */
  used: number
  /** 可用（字节） */
  avail: number
  /** 占用率 0-100 */
  usePct: number
}

/** 物理磁盘（lsblk TYPE=disk + /proc/diskstats 读写计数器差值） */
export interface PerfDisk {
  /** 设备名（vda） */
  name: string
  /** 盘总容量（字节） */
  total: number
  /** 读/写速度（字节/秒）；首轮无差值基准时为 null */
  readBps: number | null
  writeBps: number | null
  /** 该盘下的分区挂载点 */
  mounts: PerfDiskMount[]
}

/** GPU 计算进程（nvidia-smi --query-compute-apps；面板只保留显存占用前几个） */
export interface PerfGpuProc {
  /** 进程号 */
  pid: number
  /** 可执行文件路径（远端原样给出，可能很长） */
  name: string
  /** 显存占用（字节；nvidia-smi 的 MiB 已换算） */
  mem: number
}

/** NVIDIA GPU 快照（nvidia-smi --query-gpu 单卡采集；远端不支持的字段记 null） */
export interface PerfGpu {
  /** 卡序号（nvidia-smi index，多卡 0..N-1） */
  index: number
  /** 卡 UUID（nvidia-smi uuid；进程行按它回填 procs，也可作稳定标识） */
  uuid: string
  /** 型号（NVIDIA GeForce RTX 2080 Ti） */
  name: string
  /** 驱动版本（同一主机各卡相同） */
  driver: string
  /** 显存已用 / 总量（字节；nvidia-smi 的 MiB 已换算） */
  memUsed: number
  memTotal: number
  /** 核心利用率 0-100；不可得为 null */
  utilPct: number | null
  /** 核心温度（摄氏度）；不可得为 null */
  tempC: number | null
  /** 当前功耗 / 功耗墙（瓦）；不可得为 null */
  powerW: number | null
  powerCapW: number | null
  /** 风扇转速（%）；数据中心卡无风扇为 null */
  fanPct: number | null
  /** 占用显存最多的前几个计算进程（远端拿不到进程信息时为空数组） */
  procs: PerfGpuProc[]
}

/** GPU 样本（会话面板的独立低频流：只采 GPU，与 PerfSample 的 3s/10s 全量采样分开走） */
export interface PerfGpuSample {
  hostId: string
  /** 该主机全部 GPU（按 nvidia-smi index 升序）；无 nvidia-smi / 无卡为空数组 */
  gpus: PerfGpu[]
  t: number
}

/** 主机系统名兜底采集事件（SSH 会话链路建立后单次 exec；性能监控不可用时的缓存刷新路径） */
export interface OsSampleEvent {
  hostId: string
  /** 发行版（/etc/os-release PRETTY_NAME），未知为空串 */
  osName: string
}

/** InfoSheet 用 stat 详情（对照 SftpItemDetail，省略 ssh2 不回传的 extended/created） */
export interface SftpStat {
  size: number
  permissions: number | null
  uid: number | null
  gid: number | null
  accessed: number | null
  modified: number | null
  childFiles: number | null
  childDirs: number | null
}

/** 对照 SftpEditPayload：编辑器可打开性判定 */
export type SftpEditPayload =
  | {
      kind: 'text'
      text: string
      encoding: FileEncoding
      bom: boolean
      confidence: number
      lossy: boolean
      binary: boolean
      size: number
    }
  | { kind: 'tooLarge' }

/* ---------------- AI Agent（⑤） ---------------- */

export type AiProviderPreset = 'deepseek' | 'qwen' | 'ollama' | 'custom'

export type AiApprovalLevel = 'strict' | 'default' | 'relaxed'

/** 供应商（OpenAI-compatible 端点）：只管连接与密钥，不绑定模型；API Key 按 id 另存（ai-secrets） */
export interface AiProvider {
  id: string
  /** 显示名 */
  label: string
  baseURL: string
  /** 显式免密模式：请求不得携带该供应商已存储的密钥。 */
  noKey?: boolean
}

/** 模型消费场景：chat = 主对话 / judge = 审批灰区子判定 / title = 会话标题总结 */
export type AiScenario = 'chat' | 'judge' | 'title'

/** 场景 → 模型绑定（供应商 + 模型 id） */
export interface AiModelBinding {
  providerId: string
  model: string
}

export interface AiContextSettings {
  contextWindow: number
  autoCompress: boolean
}

/** 最近一次模型请求的输入上下文，不是会话累计计费 tokens。 */
export interface AiContextUsage {
  modelKey: string
  contextWindow: number
  inputTokens: number
  source: 'estimate' | 'provider'
  phase: 'ready' | 'compressing'
}

/** AI 配置（非密钥；API Key 经 aiSecrets 按 providerId 单独 safeStorage）。
 *  场景回退链 title → judge → chat：最少只配 chat 即可全功能工作。
 *  modelCache = 各供应商最近一次拉取的模型 id 列表（对话切换器/场景下拉共用）。 */
export interface AiConfig {
  providers: AiProvider[]
  scenarios: Partial<Record<AiScenario, AiModelBinding | null>>
  modelCache?: Record<string, string[]>
  /** 按 [providerId, model] 保存，切换模型后保留各自窗口与压缩设置。 */
  modelSettings?: Record<string, AiContextSettings>
  approvalLevel: AiApprovalLevel
}

/** One actual SSH transport, distinct from a saved host configuration or shell channel. */
export interface SshConnectionSession extends HostLinkSnapshot {
  connectionId: string
  owner: 'user' | 'agent'
  sessionId?: string
  shellCount?: number
}

/** 消息元数据：createdAt 由发送方写入；display = 用户消息的原文（正文 text 为经提示词层展开的 payload）；
 *  error = 该回合的流内错误（回合收尾时由 main 写入并持久化） */
export interface AiFileReference {
  hostId: string
  hostName: string
  host: string
  port: number
  username: string
  path: string
  name: string
  isDir: boolean
}

export interface AiMessageMetadata {
  createdAt: number
  display?: string
  fileReferences?: AiFileReference[]
  hostReferences?: { id: string; name: string; host: string; port: number }[]
  error?: string
  interrupted?: boolean
  contextCompressed?: boolean
  contextUsage?: AiContextUsage
  finishReason?: string
}

/** 对话消息即 AI SDK UIMessage（主进程持久化、渲染层展示、convertToModelMessages 的唯一格式） */
export type AiUIMessage = UIMessage<AiMessageMetadata>

/** main → renderer 事件（ai:event）：回合流片 / 回合结束 /
 *  会话标题 / 执行器通知（渲染层以用户消息投递给 agent） */
export type AiEvent = { sessionId: string } & (
  | { type: 'chunk'; turnId: string; chunk: UIMessageChunk }
  | { type: 'turn-end'; turnId: string }
  | { type: 'context-usage'; turnId: string; usage: AiContextUsage }
  | { type: 'title'; title: string }
  /** 标题生成中（true 开始 / false 结束）：UI 在标题位置显示转圈 */
  | { type: 'title-pending'; pending: boolean }
  | { type: 'notify'; text: string }
)

/** 会话摘要（main 侧 agent 持久化；标题首次对话生成、每 3 轮由子模型刷新） */
export interface AiSessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}
