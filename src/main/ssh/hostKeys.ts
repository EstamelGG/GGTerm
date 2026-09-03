import Store from 'electron-store'
import { createHash } from 'node:crypto'

const store = new Store<{ hosts: Record<string, string> }>({
  name: 'known-hosts',
  defaults: { hosts: {} }
})

/** Shared by tests, interactive connections and performance probes. First use is trusted automatically. */
export function createHostVerifier(
  host: string,
  port: number
): {
  verify: (key: Buffer) => boolean
  error: () => Error | null
} {
  let failure: Error | null = null
  const endpoint = JSON.stringify([
    host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, ''),
    port
  ])
  return {
    error: () => failure,
    verify: (key) => {
      try {
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
        const hosts = store.get('hosts')
        const previous = hosts[endpoint]
        if (previous && previous !== fingerprint) {
          failure = Object.assign(
            new Error(
              `SSH host key changed, connection blocked: ${host}:${port}\nSaved: ${previous}\nReceived: ${fingerprint}`
            ),
            { code: 'HOST_KEY_CHANGED' }
          )
          return false
        }
        if (!previous) store.set('hosts', { ...hosts, [endpoint]: fingerprint })
        return true
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err))
        return false
      }
    }
  }
}
