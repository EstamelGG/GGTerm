import { Monitor } from 'lucide-react'
import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siLinux,
  siOpensuse,
  siRedhat,
  siRockylinux,
  siUbuntu
} from 'simple-icons'

/**
 * 连接行第一列的系统图标：按性能样本 osName（/etc/os-release）匹配品牌 logo（simple-icons，品牌色）。
 * 未采样/未识别 → 回退 Monitor 线条图标；匹配按数组顺序即优先级（发行版先于 linux 兜底）。
 */

interface OsIconDef {
  path: string
  hex: string
}

/** Windows logo 已因商标政策从 simple-icons 移除，按其标准四格几何自绘（品牌蓝） */
const WINDOWS: OsIconDef = {
  path: 'M0 3.449L9.812 2.106v9.361H0zM10.984 1.943L24 0v11.4H10.984zM0 12.5h9.812v9.36L0 20.517zM10.984 12.5H24V24l-12.69-1.806z',
  hex: '0078D4'
}

const MATCHERS: [RegExp, OsIconDef][] = [
  [/ubuntu/i, siUbuntu],
  [/debian/i, siDebian],
  [/centos/i, siCentos],
  [/fedora/i, siFedora],
  [/red\s?hat|rhel/i, siRedhat],
  [/rocky/i, siRockylinux],
  [/alma/i, siAlmalinux],
  [/alpine/i, siAlpinelinux],
  [/arch/i, siArchlinux],
  [/opensuse|suse/i, siOpensuse],
  [/darwin|mac\s?os/i, siApple],
  [/windows/i, WINDOWS],
  [/linux/i, siLinux]
]

export function OsIcon({
  osName,
  size = 13,
  badge = false,
  onLight = false
}: {
  osName: string
  size?: number
  /** 白色圆角方形底色（主机列表行用） */
  badge?: boolean
  /** 渲染在浅色底上（如拓扑图白色节点圆）：未识别图标改用深灰保证对比度 */
  onLight?: boolean
}): React.JSX.Element {
  const hit = osIconOf(osName)
  // badge 的白底与 onLight 的浅色底都需要深灰兜底图标 —— 浅灰（--at-muted）在浅底上不可见
  const light = badge || onLight
  const icon = hit ? (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-hidden="true">
      <path d={hit.path} fill={`#${hit.hex}`} />
    </svg>
  ) : (
    <Monitor size={size} strokeWidth={2} className={light ? 'text-[#6b7280]' : 'text-muted'} />
  )
  if (!badge) return icon
  return (
    <span className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-md bg-white">
      {icon}
    </span>
  )
}

/** osName → 品牌 logo 定义（SVG path 24×24 + 品牌色 hex） */
function osIconOf(osName: string): OsIconDef | undefined {
  return osName ? MATCHERS.find(([re]) => re.test(osName))?.[1] : undefined
}
