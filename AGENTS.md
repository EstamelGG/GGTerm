# Agent 工作规则（本仓库）

## 文件编辑（强制）

- **绝对禁止在同一消息中并行修改同一个文件。**
  `SearchReplace` 是“读取 → 修改 → 写回”三步操作；对同一文件的并行编辑会互相基于过期快照写回，
  后写入者静默覆盖先写入者的修改（表现为“工具报告成功但内容丢失”，已在本项目实际发生过）。
  - 同一文件的多处修改：必须拆成多条消息**依次串行**执行。
  - 不同文件之间：允许并行。
  - 批量编辑后：用 grep 复核目标模式是否仍残留，防止静默丢失。

## 其他约定

- 字号只使用 `main.css @theme` 中的四档 token（caption 11 / minor 12 / body 13 / title 15），收敛原则"只增不减"。
- 等宽字体栈统一 `'JetBrains Mono', 'Noto Sans SC Variable', monospace`（JetBrains Mono 经 @fontsource 内置 latin 400/500/700；Noto Sans SC 经 @fontsource-variable 内置 100–900，均离线可用）。终端/Monaco/路径/日志/等宽输入共用 `--font-mono` 栈，新增 mono 场景不得自写字体栈；Canvas 终端需要显式加载中文分片并刷新字形缓存。
- UI 规格以 AT token 体系（`--at-*`）为唯一事实来源；`components/ui/` 下 shadcn 基础件已 AT 化默认值，调用点不要再覆写。
- 按钮禁用态统一用原生 `disabled` prop（不是 `enabled`）。
