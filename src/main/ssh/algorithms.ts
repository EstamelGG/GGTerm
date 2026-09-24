import type { ConnectConfig } from 'ssh2'

/** Modern algorithms first; allow legacy KEX unless this hop explicitly requires modern KEX. */
export function sshAlgorithms(strictKex?: boolean): ConnectConfig['algorithms'] {
  return !strictKex
    ? {
        kex: {
          append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'],
          prepend: [],
          remove: []
        }
      }
    : undefined
}
