import type { HostConnection } from './types'

export const DEVICE_TYPES = {
  linux: 'Linux',
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  rhel: 'Red Hat Enterprise Linux',
  rocky: 'Rocky Linux',
  almalinux: 'AlmaLinux',
  centos: 'CentOS',
  fedora: 'Fedora',
  suse: 'SUSE / openSUSE',
  alpine: 'Alpine Linux',
  arch: 'Arch Linux',
  huawei: 'Huawei / 华为交换机',
  zte: 'ZTE / 中兴交换机',
  h3c: 'H3C / 新华三交换机',
  cisco: 'Cisco',
  juniper: 'Juniper',
  ruijie: 'Ruijie / 锐捷',
  network: 'Other network device / 其他网络设备'
} as const
export type DeviceType = keyof typeof DEVICE_TYPES
const NETWORK_TYPES: DeviceType[] = [
  'huawei',
  'zte',
  'h3c',
  'cisco',
  'juniper',
  'ruijie',
  'network'
]
export function isNetworkDevice(conn: Pick<HostConnection, 'deviceType'> | undefined): boolean {
  return !!conn?.deviceType && NETWORK_TYPES.includes(conn.deviceType)
}
export function deviceGuidance(conn: Pick<HostConnection, 'deviceType'>): string {
  const label = conn.deviceType ? DEVICE_TYPES[conn.deviceType] : 'Unspecified'
  return (
    `Host type: ${label}. ` +
    (isNetworkDevice(conn)
      ? 'Network appliance CLI, NOT a Linux shell. Start without a command and inspect banner/login prompts first. Use only commands supported by the confirmed vendor, OS version and current CLI mode. Never send Linux/POSIX commands, shell scripts, /proc probes, package-manager commands or assume SFTP. Do not enter a Linux shell to bypass this restriction. Configuration changes, save/commit, reboot and interface changes require explicit user authorization; explain connectivity impact first.'
      : conn.deviceType
        ? 'Use commands appropriate to this Linux distribution; verify installed tools and privileges first.'
        : 'Do not assume Linux. Identify the platform from login banner and CLI prompts before issuing platform-specific commands.')
  )
}
