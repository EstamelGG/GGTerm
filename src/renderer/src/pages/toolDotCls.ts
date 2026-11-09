import type { DynamicToolUIPart, ToolUIPart } from 'ai'

/** 工具块状态点（SDK ToolUIPart.state）：执行/审批中=蓝闪，完成=绿，人工待审批/拒绝=黄，出错=红 */
export function toolDotCls(p: ToolUIPart | DynamicToolUIPart): string {
  switch (p.state) {
    case 'output-available':
      return 'bg-ok'
    case 'output-error':
      return 'bg-danger'
    case 'approval-requested':
      // 自动审批流片会短暂落在此态；不按人工待批黄点闪，避免「先黄后绿」
      return p.approval?.isAutomatic ? 'bg-info animate-pulse' : 'bg-warn'
    case 'output-denied':
      return 'bg-warn'
    case 'approval-responded':
      return p.approval.approved ? 'bg-info animate-pulse' : 'bg-warn'
    default:
      return 'bg-info animate-pulse'
  }
}
