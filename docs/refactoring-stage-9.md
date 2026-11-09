# 重构第九批：AI 工作区职责拆分

日期：2026-11-03。基于 `9286618`。

将 AiWorkspacePage 拆为页面编排与六个模块：工具摘要/结果格式化 presentation、工具调用与审批 ToolCallCard、敏感人工输入 HumanInputCard、消息与思考时间线 MessageItem、输入草稿与模型选择 ChatComposer、会话列表 SessionList。

38 个顶层声明经 TypeScript 标准化打印比较，除导出标记及 import 外实现体保持一致。保留 memo、组件 key、输入框生命周期、敏感值清空、滚动跟随与审批路由；公共页面导出不变。本批没有更改原有轮询策略，后续再集中处理重复执行查询。

新增 4 项交互测试：敏感输入成功/失败后清空、批量审批的会话/审批 ID、草稿在重渲染时保留及发送后清空。

验证：105 个测试文件，494 项通过、1 项原有跳过；另 5 项 SSH 签名测试通过。lint、构建（含类型检查）、桌面回归及 diff 检查通过。Windows 实机测试通过；原有大分包和 Electron vm 提示保留。
