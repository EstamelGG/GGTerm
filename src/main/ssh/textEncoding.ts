import iconv from 'iconv-lite'
import { analyse } from 'chardet'
import { isFileEncoding, type EncodingMode, type FileEncoding } from '../../shared/encoding'

const aliases: Record<string, FileEncoding> = {
  'UTF-8': 'utf8',
  'UTF-16LE': 'utf16le',
  'UTF-16BE': 'utf16be',
  GB18030: 'gb18030',
  GB2312: 'gb18030',
  Big5: 'big5',
  Shift_JIS: 'shift_jis',
  'EUC-JP': 'euc-jp',
  'EUC-KR': 'euc-kr',
  'windows-1252': 'windows1252',
  'ISO-8859-1': 'iso88591'
}

export function decodeFile(
  bytes: Buffer,
  mode: EncodingMode = 'auto'
): {
  text: string
  encoding: FileEncoding
  bom: boolean
  confidence: number
  lossy: boolean
  binary: boolean
} {
  if (mode !== 'auto' && !isFileEncoding(mode)) throw new Error('Unsupported encoding')
  let encoding: FileEncoding = mode === 'auto' ? 'utf8' : mode
  let confidence = 100
  if (mode === 'auto') {
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) encoding = 'utf8-bom'
    else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) encoding = 'utf16le'
    else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) encoding = 'utf16be'
    else {
      const sample = bytes.subarray(0, 8192)
      let evenZeros = 0
      let oddZeros = 0
      for (let i = 0; i < sample.length; i++) {
        if (sample[i] === 0) {
          if (i % 2) oddZeros++
          else evenZeros++
        }
      }
      const utf16 =
        bytes.length % 2 === 0 && sample.length >= 4
          ? oddZeros > sample.length * 0.2 && evenZeros < sample.length * 0.05
            ? 'utf16le'
            : evenZeros > sample.length * 0.2 && oddZeros < sample.length * 0.05
              ? 'utf16be'
              : null
          : null
      if (utf16) {
        encoding = utf16
        confidence = 80
      } else {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          const hit = analyse(bytes.subarray(0, 256 * 1024)).find((x) => aliases[x.name])
          encoding = hit ? aliases[hit.name] : 'utf8'
          confidence = hit?.confidence ?? 0
        }
      }
    }
  }
  const codec = encoding === 'utf8-bom' ? 'utf8' : encoding
  const raw = iconv.decode(bytes, codec, { stripBOM: false })
  const bom = raw.startsWith('\uFEFF')
  const text = bom ? raw.slice(1) : raw
  const lossy = !iconv.encode(raw, codec).equals(bytes)
  const sample = text.slice(0, 8192)
  const controls = [...sample].filter((c) => {
    const code = c.charCodeAt(0)
    return code <= 8 || (code >= 14 && code <= 31)
  }).length
  const binary = sample.includes('\0') || controls > Math.max(2, sample.length * 0.02)
  return { text, encoding, bom, confidence, lossy, binary }
}

/** Validate before touching the remote file; encoders otherwise replace unrepresentable characters. */
export function encodeFile(text: string, encoding: FileEncoding, bom = false): Buffer {
  if (!isFileEncoding(encoding)) throw new Error('Unsupported encoding')
  const codec = encoding === 'utf8-bom' ? 'utf8' : encoding
  const bytes = iconv.encode(text, codec)
  if (iconv.decode(bytes, codec, { stripBOM: false }) !== text) {
    throw new Error(
      'Characters cannot be saved in this encoding; use an encoding that supports them'
    )
  }
  if (encoding === 'utf8-bom' || (bom && codec === 'utf8'))
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
  if (bom && codec === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), bytes])
  if (bom && codec === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), bytes])
  return bytes
}
