export const FILE_ENCODINGS = [
  { id: 'utf8', label: 'UTF-8' },
  { id: 'utf8-bom', label: 'UTF-8 BOM' },
  { id: 'utf16le', label: 'UTF-16 LE' },
  { id: 'utf16be', label: 'UTF-16 BE' },
  { id: 'gb18030', label: 'GB18030 / GBK' },
  { id: 'big5', label: 'Big5' },
  { id: 'shift_jis', label: 'Shift JIS' },
  { id: 'euc-jp', label: 'EUC-JP' },
  { id: 'euc-kr', label: 'EUC-KR' },
  { id: 'windows1252', label: 'Windows-1252' },
  { id: 'iso88591', label: 'ISO-8859-1' }
] as const

export type FileEncoding = (typeof FILE_ENCODINGS)[number]['id']
export type EncodingMode = FileEncoding | 'auto'

export function isFileEncoding(value: string): value is FileEncoding {
  return FILE_ENCODINGS.some((encoding) => encoding.id === value)
}
