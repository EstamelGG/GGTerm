/**
 * Chrome 布局共享常量：工具行/标签行此前在多个页面各自硬编码凑对齐，
 * 任一端改动即失配；收敛到此处单一事实来源。
 */

/** 工具行垂直 padding（+ h-6 内容 = 40px 行高；对称 padding 保证内容在行内几何居中）；
 *  ConnectionPage 工具栏与 GroupSidebar 头部共用 */
export const TOOLBAR_V = 'py-2'

/** chrome 标签行（文件标签栏 / shell 标签栏 / 本地控制台标签栏）：
 *  固定 h-10（= 有标签时 chips 24px + py-2×2 的自然高度）——空标签行不因内容变矮而抖动，
 *  全关标签后 '+'/状态胶囊位置保持不动 */
export const CHROME_ROW = 'flex h-10 shrink-0 items-center gap-1.5 bg-sidebar px-3'
