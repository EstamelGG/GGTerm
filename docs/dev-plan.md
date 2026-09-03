# 开发计划（待实施）

> 来源：XTerminal 逆向研究（`refer/xterminal-study/`）+ SFTP 优化方案评审，2026-09 沉淀。
> 已完成项（传输速度显示、swap/网络速率/OS 发行版采集、进度节流、readlink 并发、探测连接 NoDelay）不在本文件范围内。

## ① SFTP list 分页防护（超大目录）

**问题**：`list()` 无上限读全量，50 万条目录会阻塞数十秒；IPC 单帧膨胀（千条级即明显）。

**方案**（参考 XTerminal `08-rpc-gateway.js` 的 `readdirAsync`）：

- 主进程 `list(path, limit=3000)`：用 `opendir` 句柄版 `readdir(handle)` 分批读，返回 `{ entries, hasMore, total }`
- `hasMore = !eof || count >= limit`（读满不等于读完，注意判定）
- 渲染层树在目录末尾渲染"加载更多"行，触发续读（需把 handle 或 offset 存主进程会话）
- 排序只在已加载分页内做（现有渲染层排序天然满足）；不假设 readdir 返回有序
- IPC 序列化时考虑 omit `longname`（InfoSheet 原始列表需要，需按需字段或保留）

**验收**：手工构造 10 万条目录，首屏秒开，滚动加载不丢条目。

## ② 多文件 tar 旁路传输

**问题**：海量小文件逐文件传输，open/close 固定开销主导，且吃不到压缩红利。

**方案**（参考 XTerminal `04-tar-bypass.js` / `05-local-tar.js`）：

- 触发判据：平均文件 < 64KB 且数量 > 100（目录递归预估或首层采样）
- 下载：远端 `tar -czf <tmp> -C <dir> <names>` → `fastGet` 单流下载 → 本地解包
- 上传：本地 node-tar（`tar` npm 包 `c/x` + gzip）在 temp 打包 → `fastPut` → 远端 `tar -xzvf <tmp> -C <dest> --overwrite`
- 远端命令落 `src/main/ssh/remoteScripts.ts`（现有集中维护点）
- 必备细节：
  - 远端 `tar` 存在性探测 + 结果缓存（参考 XTerminal `hasCommand`：`which tar` → Map 缓存）
  - temp 文件随机名 + 用完即删（失败也要清理）
  - 已压缩文件（.zip/.mp4/备份包等）按扩展名跳过该路径，白烧 CPU 零收益
  - 失败降级回逐文件路径
  - tar 保权限/符号链接/属主（SFTP 逐文件反而不保，是隐藏收益）
  - 进度粒度变粗（只有总流进度），传输条 UI 需标注"打包传输中"

**验收**：`node_modules` 级目录（数万小文件）下载时间对比逐文件路径有数量级优势；无 tar 服务器正常降级。

## ③ 传输取消与断点续传

**问题**：传输无取消入口；中断后重传从头开始。

**方案**（参考 XTerminal `01-connection-sftp-core.js`）：

- 取消：传输任务加 `__isCanceled` 标记，取消时 `sftp.end()` 通道级打断 + 传输条加取消按钮
- 断点续传：
  - 下载：本地 `stat` 已有大小 → `sftp.createReadStream(remote, { start: size })` + 本地 `createWriteStream(local, { flags: 'a' })` 管道
  - 上传：对称（远端 stat 大小 → 本地 `createReadStream({ start })` + 远端 append）
  - 校验失败（远端大小异常）回退从头
- 进度事件沿用现有 100ms 节流 + speed 字段

**验收**：大文件传输中取消立即停止；中断后续传从断点继续且最终文件完整。

## ④ 端口转发（功能域，远期）

**参考**：XTerminal `03-ssh-service.js` 的 `forwardIn/forwardOut/unForwardIn`（ssh2 `forwardOut` / `forwardIn` / `unforwardIn`）。

- 正向（本地 → 远端网络）：`forwardOut`；反向（远端 → 本地）：`forwardIn` + `tcp connection` 事件接 `net.connect`
- UI：连接信息面板/右键菜单入口 + 转发列表管理（状态、取消）
- 错误提示本地化（EADDRINUSE/EACCES/ECONNREFUSED/ENOTFOUND → 中文，XTerminal 有现成映射可抄）
- 连接生命周期联动：主机断线时转发状态清理与恢复提示

## ⑤ AI Agent 模块（新功能域，方案已评审共识 2026-09-11）

**定位**：BYOK 多厂商 AI agent，可操作全部 SSH 连接与会话（package.json 既有方向 "SSH terminal + AI agent framework"）；tool 优先、命令执行过风险门。

### 架构

- **主进程 `src/main/ai/`**：直接复用 `getLink/getOrCreateLink`（连接注册表）、`listConnections`、`loadSecrets`、`execCommand`（非交互 exec）、`localShell`（本地执行），不穿透 IPC；`sessionPerf.ts` 的独立模块借共享连接是现成先例。
- **IPC**：新增 `ai:` 域（`channels` 条目 + `registerIpc()` + preload 命名空间，与现状同构）；事件流 `ai:message` / `ai:approval` 回渲染层。
- **感知**：主进程在 ShellSession / pty 转发处写每 shell 环形缓冲（~128KB），`read_output` 工具读取时剥离 ANSI/控制序列（TUI 输出为乱码流，需清洗）。不反向拉取渲染层 xterm buffer。

### 行为模型

- **tool 优先**：读文件走 SFTP 工具而非 `cat`，SFTP 不可用才降级为命令。其他功能同理：列目录、读文件、写文件、删文件、改名等，能用tool优先用tool，能用exec直接用exec，实在不行（比如真的是交互式环境）才在shell窗口打字执行。
- 要求agent一次次执行命令，不直接执行复合的命令。
- **三层风险门（命令执行）**：
  1. 静态只读白名单（`ls/cat/head/df/ps` 等，且无管道/重定向/命令串联）→ 直行，不调子 agent；
  2. 静态危险黑名单（`rm/dd/mkfs/chmod -R/systemctl/kill/curl|sh` 等）→ 无论 LLM 判定一律弹确认卡（防假阴性）；
  3. 灰区 → 子 agent 语义判定（分析意图与后果）。子 agent 默认跟随主模型，可单独配置更便宜的模型。
- **SFTP 简化门**：只读（list/read/stat）直行；写/删/改名确认（语义简单，无需子 agent 层）。
- **会话管理**：建连/开 shell 直行；断连/关 shell 需确认（可能杀正在跑的任务）。
- **审批卡**：完整命令 + 目标主机/会话 + 触发层级与子 agent 理由 + 批准/拒绝。

### UI 与产品改动

- **独立 AI 工作区 tab**：入口替换 header 本地终端按钮位（Connections | AI | hosts…），`WorkspaceTab` 瘦身为 `connections | ai | host`。
- **本地终端删 UI 留执行**：删 `LocalTerminalPage` / session store 的 localConsoles / `local:` UI 链路及相关 i18n、菜单；pty/localShell 保留供 AI 本地执行工具使用。
- **审批可见性**：审批卡在 AI 工作区内；触发时 header AI 按钮红点徽标 + 全局 toast，点击跳转工作区。
- **设置**：SettingsSheet 新增 AI 节（provider / API Key / BaseURL / 主模型 / 子 agent 模型 / 审批偏好），密钥走 `secrets.ts` 同款 safeStorage。

### 框架与工具面

- **Vercel AI SDK**（`ai` + provider 包；OpenAI-compatible 端点一套覆盖 DeepSeek/Qwen/Ollama/自建网关）；工具层自研闭包实现，不引入 MCP（生态接入留后续）；审批实现为挂起的 tool call，由 IPC 用户动作 resolve。
- 首期工具面：`list_connections / connect / disconnect / open_shell / close_shell / sftp_list / sftp_read / sftp_write / sftp_delete / sftp_mkdir / sftp_rename / exec_command / local_exec / read_output`。

### 分期

- **一期**：主进程 agent 核心（框架接入/工具层/三层门/环形缓冲）+ `ai:` IPC + AI 工作区（对话流/工具调用卡/审批卡）+ 设置 AI 节 + 本地终端 UI 移除。
- **二期**：任务看板、审批卡内命令可编辑、终端上下文注入（选区/滚动区）、MCP 生态接入评估。

### 验收

- 端到端："查看某主机 nginx 配置并重启服务"——AI 经 SFTP 读配置 → `systemctl restart` 触发审批卡 → 批准后执行 → `read_output` 汇报结果，全程徽标+toast 正常提醒。
- 风险门：白名单命令无感直行；黑名单命令无论子 agent 如何判定均弹卡；构造子 agent 假阴性测试用例（如伪装只读的 `find / -delete`）被黑名单拦截。
- 本地终端 UI 移除后 `npm run typecheck` / `npm run test` 全绿，AI 本地执行工具可用。

## 实施顺序建议

② 与 ③ 同域（传输），建议先 ③（体验刚需）再 ②（性能优化）；① 独立可穿插；④ 等核心稳定后单独立项。⑤ 为独立大项，按上述内部分期单独立项实施，不与 ①—④ 抢占。
