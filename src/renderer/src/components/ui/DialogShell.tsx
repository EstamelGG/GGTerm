import type { ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

/**
 * 全应用统一弹窗骨架（bar 式）：
 * 顶栏（bg-sidebar + 标题 + 右上关闭）→ 内容区 → 底栏（左次要/右主操作）。
 * 所有弹窗（表单/确认/信息）一律经由本组件，保证标题字号、padding、圆角、
 * 按钮排布单一事实来源。宽度用 style 传入（368/380/400/420/460/720 等档）。
 */
export function DialogShell({
  open,
  onOpenChange,
  title,
  width = 420,
  contentClassName,
  /** false = 阻断型模态：点遮罩/Esc/右上 X 均不可关（如手动认证） */
  dismissable = true,
  /** true = 阻止初始焦点落到关闭钮（表单类，让首个输入框 autoFocus 生效） */
  preventAutoFocus = false,
  footerAside,
  footer,
  /** 顶栏右侧动作区（关闭钮左侧；如"计算大小"等与标题同级的操作） */
  headerActions,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  width?: number
  contentClassName?: string
  dismissable?: boolean
  preventAutoFocus?: boolean
  footerAside?: ReactNode
  footer?: ReactNode
  headerActions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!dismissable && !o) return
        onOpenChange(o)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-shell-overlay"
          className="fixed inset-0 z-50 bg-black/45 shadow-none backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          data-slot="dialog-shell"
          className="fixed top-[50%] left-[50%] z-50 flex max-h-[calc(100%-3rem)] w-full translate-x-[-50%] translate-y-[-50%] flex-col gap-0 overflow-hidden rounded-xl border border-line bg-modal shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          style={{ width, maxWidth: 'calc(100% - 2rem)' }}
          onOpenAutoFocus={(e) => {
            if (preventAutoFocus) e.preventDefault()
          }}
          onPointerDownOutside={(e) => {
            if (!dismissable) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (!dismissable) e.preventDefault()
          }}
          onEscapeKeyDown={(e) => {
            if (!dismissable) e.preventDefault()
          }}
        >
          {/* 顶栏 */}
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-sidebar px-3.5">
            <DialogPrimitive.Title className="min-w-0 truncate text-title font-semibold text-fg">
              {title}
            </DialogPrimitive.Title>
            <div className="flex-1" />
            {headerActions}
            {dismissable && (
              <DialogPrimitive.Close
                data-slot="dialog-shell-close"
                className="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-150 outline-none hover:bg-hover/80 hover:text-fg focus-visible:ring-[1.5px] focus-visible:ring-at-accent/70"
              >
                <XIcon className="size-3" />
                <span className="sr-only">{t('common.close')}</span>
              </DialogPrimitive.Close>
            )}
          </div>

          {/* 内容区（默认 p-4；自定义布局经 contentClassName 覆盖） */}
          <div className={cn('min-h-0 flex-1 overflow-y-auto p-4', contentClassName)}>
            {children}
          </div>

          {/* 底栏：左侧次要动作 + 右侧主操作 */}
          {(footer || footerAside) && (
            <div className="flex h-10 shrink-0 items-center gap-2 border-t border-line bg-sidebar px-3.5">
              {footerAside}
              <div className="flex-1" />
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
