/** 对照 ATerminal-Swift WindowChrome.swift ChromeSeparator：窗口铬下方的可见分隔线 */
export function ChromeSeparator({ className = '' }: { className?: string }): React.JSX.Element {
  return <div className={`h-px w-full shrink-0 bg-chrome-sep ${className}`} />
}
