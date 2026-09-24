import { test, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { Client, Server, type KexAlgorithm } from 'ssh2'
import { sshAlgorithms } from '../src/main/ssh/algorithms'

test.each([
  { modern: false, offered: ['diffie-hellman-group14-sha1'] },
  { modern: true, offered: ['diffie-hellman-group14-sha1', 'diffie-hellman-group14-sha256'] }
])('automatic negotiation with modern support=$modern', async ({ modern, offered }) => {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp521r1',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  const server = new Server(
    { hostKeys: [privateKey], algorithms: { kex: offered as KexAlgorithm[] } },
    (client) => {
      client.on('error', () => {})
      client.on('authentication', (ctx) => ctx.accept())
    }
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Missing fixture address')
  const port = address.port
  const dial = (strictKex?: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      const client = new Client()
      let negotiated = ''
      client.on('error', (err) => {
        client.destroy()
        reject(err)
      })
      client.on('ready', () => {
        client.end()
        resolve(negotiated)
      })
      client.connect({
        host: '127.0.0.1',
        port,
        username: 'fixture',
        readyTimeout: 2000,
        algorithms: sshAlgorithms(strictKex),
        debug: (line) => {
          const prefix = 'Handshake: KEX algorithm: '
          if (line.startsWith(prefix)) negotiated = line.slice(prefix.length)
        }
      })
    })
  try {
    const expected = modern ? 'diffie-hellman-group14-sha256' : 'diffie-hellman-group14-sha1'
    await expect(dial()).resolves.toBe(expected)
    await expect(dial(false)).resolves.toBe(expected)
    if (modern) await expect(dial(true)).resolves.toBe(expected)
    else await expect(dial(true)).rejects.toThrow('no matching key exchange algorithm')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
