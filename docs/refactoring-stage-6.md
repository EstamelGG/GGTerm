# 重构第六批：连接 IPC 与工作区页面拆分

日期：2026-11-03。基于第五批检查点 `fd65ca2`，本批按职责拆分模块，保留现有功能、数据格式和对外接口。

## 主进程 IPC

- `src/main/ipc.ts` 保留 `registerIpc()` 入口和 `channels` 再导出，现有调用方无需迁移。入口负责注册各领域模块，偏好、语言、日志和 AI 会话处理暂时留在入口。
- `ipc/channels.ts` 集中保存原有通道常量。
- `ipc/connections.ts` 注册连接配置、分组、凭据、本地 SSH 配置和连接测试相关处理。
- `ipc/workspace.ts` 注册主机、Shell、连接运行快照、选择性断开及端口转发处理，集中维护链路事件转发器。
- `ipc/sftp.ts` 注册远程文件、传输及相关本地文件访问处理；接收工作区的同一个链路事件工厂，避免拆分后自动转发状态或事件归属分叉。
- `ipc/performance.ts` 注册性能快照、观察、暂停与刷新处理。

迁移前后逐项核对了原入口的 84 个 IPC 注册：通道值、handle/on 类型及全部回调参数和实现 token 均一致，且没有重复注册。preload 和 shared 接口未改动；Shell 延迟启动、查看模式不新建用户连接、按真实连接 ID 关闭和事件发送前检查窗口有效性保持不变。

## App

- `app/useAppRuntime.ts` 接管偏好初始化、执行任务轮询、连接标题同步及全局事件订阅和退订。
- `app/useWorkspaceClose.ts` 接管原生关闭请求、未保存文件保护、关闭确认状态及受影响转发数量计算。
- `app/useToast.ts` 接管通知和计时器，提供稳定的通知回调，并在卸载时清理计时器。
- `app/AppHeader.tsx` 接管导航、主机标签和全局状态提示。导航状态仍来自现有 store。
- `App.tsx` 保留页面编排、页面挂载条件、全局关闭对话框、工作区错误呈现与日志面板。

## HostSessionPage

- `host/useHostLayout.ts` 接管分栏尺寸、响应式收纳、拖动预览、尺寸观察和原有 localStorage 键。
- `host/HostFilesPane.tsx` 接管文件标签、懒加载编辑器和未保存文件关闭确认。
- `host/ManualAuthDialog.tsx` 接管认证表单及提交后的敏感字段清空。
- `host/HostConnectionStatus.tsx` 接管 Shell 展示、链路状态和状态信息行。
- `HostSessionPage.tsx` 保留 SFTP/终端/Agent 工作区编排及重连操作。

HostSessionPage 的导出和参数不变。文件面板与认证组件在主机页面存续期间保持挂载，继续使用原有编辑器与终端标识；文件面板使用 Fragment，保留分栏的 DOM 布局关系。未改变原有主机页面切换时的挂载策略。

## 回归结果

新增 7 项测试，覆盖查看连接、手动认证与 Shell 延迟启动、事件发送与转发状态共享、选择性关闭校验、原生关闭与刷新保护、关闭监听退订及通知计时器清理。

- `npm test`：100 个测试文件通过，462 项通过、1 项原有外部供应商用例跳过；另 5 项 SSH 签名测试通过。
- `npm run lint`：通过，0 error、0 warning。
- `npm run build`：通过，包含 node/web 类型检查。
- `npm run test:smoke`：真实桌面启动、手动登录取消、设置导航、SSH/SFTP、GB18030 读写、未保存文件关闭保护、分栏拖动、窄窗口 SFTP 和 Agent 查看/终止通过；没有 Monaco DisposableStore 泄漏日志。
- `npm run test:connection-isolation`：三个 SSH 连接独立存续、借用 SFTP 清理、选择性断开与保留 Shell 输入通过。
- `npm run test:execution`：真实 SSH 交互、工作目录/环境保留、退出码和终止通过。
- `npm run test:pty-cleanup`：Windows 快速/重复关闭、自然退出、子进程树清理和相邻终端隔离通过。
- `git diff --check`：通过。

实机验证平台为 Windows，未进行 Linux/macOS 实机回归。构建仍有大分包提示，Electron renderer 仍有 vm 模块提示；本批未涉及这两项依赖问题。

## 后续边界

连接与工作区 IPC 的职责已经分离；剩余偏好、语言、日志和 AI 注册可在后续独立批次继续拆分。终端和 Agent 工作区的进一步拆分应继续保留关闭保护、资源标识和事件生命周期回归，本批不改写底层连接服务。
