import type { ServerNote } from './types'

export function noteHasContent(n: ServerNote | undefined): boolean {
  if (!n) return false
  return Boolean(
    n.purpose?.trim() ||
    (n.otherNics?.length ?? 0) > 0 ||
    n.internetAccess !== undefined ||
    n.containerEnabled !== undefined ||
    (n.containers?.length ?? 0) > 0 ||
    (n.images?.length ?? 0) > 0 ||
    n.cpuCores ||
    n.memory?.trim() ||
    n.disk?.trim() ||
    Object.keys(n.openPorts ?? {}).length > 0 ||
    (n.services?.length ?? 0) > 0 ||
    n.other?.trim()
  )
}
