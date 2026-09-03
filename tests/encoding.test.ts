import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { decodeFile, encodeFile } from '../src/main/ssh/textEncoding'
import { FILE_ENCODINGS } from '../src/shared/encoding'

describe('remote editor encodings', () => {
  it.each(FILE_ENCODINGS)('round trips $label without changing bytes', ({ id }) => {
    const text = id === 'windows1252' || id === 'iso88591' ? 'café\r\n' : '中文\r\nhello\n'
    const bytes = encodeFile(text, id, id.startsWith('utf16'))
    const result = decodeFile(bytes, id)
    expect(result.text).toBe(text)
    expect(result.lossy).toBe(false)
    expect(result.binary).toBe(false)
    expect(encodeFile(result.text, result.encoding, result.bom)).toEqual(bytes)
  })
  it.each(['utf8', 'utf8-bom', 'utf16le', 'utf16be'] as const)(
    'detects %s with BOM when applicable',
    (encoding) => {
      const result = decodeFile(encodeFile('hello 中文', encoding, encoding.startsWith('utf16')))
      expect(result.encoding).toBe(encoding)
      expect(result.text).toBe('hello 中文')
    }
  )
  it.each(['utf16le', 'utf16be'] as const)('detects BOM-less %s text', (encoding) => {
    const result = decodeFile(encodeFile('hello world\n', encoding))
    expect(result.encoding).toBe(encoding)
    expect(result.text).toBe('hello world\n')
    expect(result.binary).toBe(false)
  })
  it('allows overriding uncertain automatic detection for short GBK files', () => {
    const bytes = iconv.encode('服务器配置：生产环境', 'gbk')
    const result = decodeFile(bytes, 'gb18030')
    expect(result.text).toBe('服务器配置：生产环境')
    expect(result.lossy).toBe(false)
    expect(encodeFile(result.text, result.encoding, result.bom)).toEqual(bytes)
  })
  it('marks invalid decoding as lossy and refuses unrepresentable output', () => {
    expect(decodeFile(Buffer.from([0xc3, 0x28]), 'utf8').lossy).toBe(true)
    expect(() => encodeFile('emoji 😀', 'windows1252')).toThrow(/Characters/)
    expect(() => encodeFile('\ud800', 'utf8')).toThrow(/Characters/)
  })
  it('does not expose binary data as writable text', () => {
    expect(
      decodeFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 0]), 'windows1252').binary
    ).toBe(true)
  })
})
