const { Server, utils } = require('ssh2')
const iconv = require('iconv-lite')
const { OPEN_MODE, STATUS_CODE: STATUS } = utils.sftp

exports.startFixture = async () => {
  const files = new Map([
    ['/config.txt', iconv.encode('服务器配置：生产环境，中文编码测试。\n'.repeat(60), 'gb18030')]
  ])
  const clients = new Set()
  const server = new Server(
    { hostKeys: [utils.generateKeyPairSync('rsa', { bits: 2048 }).private] },
    (client) => {
      clients.add(client)
      client.on('error', () => {})
      client.on('close', () => clients.delete(client))
      client.on('authentication', (ctx) =>
        ctx.method === 'password' && ctx.password === 'test' ? ctx.accept() : ctx.reject()
      )
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (accept) => accept?.())
          session.on('window-change', (accept) => accept?.())
          session.on('shell', (accept) => {
            const stream = accept()
            stream.write('SMOKE_READY\r\n$ ')
            stream.on('data', () => {})
          })
          session.on('exec', (accept) => {
            const stream = accept()
            stream.exit(0)
            stream.end()
          })
          session.on('sftp', (accept) => {
            const sftp = accept()
            const handles = new Map()
            let sequence = 0
            const normal = (p) => (p === '.' || p === '~' ? '/' : p)
            const stats = (p) => ({
              mode: files.has(p) ? 0o100644 : 0o40755,
              uid: 1000,
              gid: 1000,
              size: files.get(p)?.length ?? 0,
              atime: 1,
              mtime: 1
            })
            const status = (id, code = STATUS.OK) => sftp.status(id, code)
            sftp.on('REALPATH', (id, p) =>
              sftp.name(id, [{ filename: normal(p), longname: normal(p), attrs: stats(normal(p)) }])
            )
            for (const event of ['STAT', 'LSTAT'])
              sftp.on(event, (id, p) => sftp.attrs(id, stats(normal(p))))
            sftp.on('OPENDIR', (id, p) => {
              const h = Buffer.from(String(++sequence))
              handles.set(h.toString(), { path: normal(p), listed: false })
              sftp.handle(id, h)
            })
            sftp.on('READDIR', (id, h) => {
              const item = handles.get(h.toString())
              if (item.listed) return status(id, STATUS.EOF)
              item.listed = true
              sftp.name(id, [
                {
                  filename: 'config.txt',
                  longname: '-rw-r--r-- 1 test test 100 config.txt',
                  attrs: stats('/config.txt')
                }
              ])
            })
            sftp.on('OPEN', (id, p, flags) => {
              if (flags & OPEN_MODE.EXCL && files.has(p)) return status(id, STATUS.FAILURE)
              if (flags & OPEN_MODE.WRITE) files.set(p, Buffer.alloc(0))
              if (!files.has(p)) return status(id, STATUS.NO_SUCH_FILE)
              const h = Buffer.from(String(++sequence))
              handles.set(h.toString(), { path: p })
              sftp.handle(id, h)
            })
            sftp.on('READ', (id, h, offset, length) => {
              const data = files.get(handles.get(h.toString()).path)
              if (offset >= data.length) return status(id, STATUS.EOF)
              sftp.data(id, data.subarray(offset, offset + length))
            })
            sftp.on('WRITE', (id, h, offset, chunk) => {
              const p = handles.get(h.toString()).path
              const previous = files.get(p)
              const data = Buffer.alloc(Math.max(previous.length, offset + chunk.length))
              previous.copy(data)
              chunk.copy(data, offset)
              files.set(p, data)
              status(id)
            })
            sftp.on('FSTAT', (id, h) => sftp.attrs(id, stats(handles.get(h.toString()).path)))
            sftp.on('FSETSTAT', (id) => status(id))
            sftp.on('CLOSE', (id, h) => {
              handles.delete(h.toString())
              status(id)
            })
            sftp.on('RENAME', (id, src, dest) => {
              files.set(dest, files.get(src))
              files.delete(src)
              status(id)
            })
            sftp.on('REMOVE', (id, p) => {
              files.delete(p)
              status(id)
            })
          })
        })
      )
    }
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    files,
    close: () => {
      for (const client of clients) client.end()
      server.close()
    }
  }
}
