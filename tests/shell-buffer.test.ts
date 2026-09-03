import { describe, expect, it } from 'vitest'
import { stripAnsi } from '../src/main/ssh/shellBuffer'

describe('terminal output sanitizing', () => {
  it('keeps text between ST-terminated OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x1b\\first\x1b]0;next\x1b\\second')).toBe('firstsecond')
  })
  it('keeps hyperlink labels and handles BEL and ST terminators', () => {
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\label\x1b]8;;\x1b\\')).toBe('label')
    expect(stripAnsi('\x1b]0;title\x07body')).toBe('body')
  })
  it('removes colon-separated CSI colors and normalizes line endings', () => {
    expect(stripAnsi('\x1b[38:2:1:2:3m中文\x1b[0m\r\n\ttext\rnext\x00')).toBe('中文\n\ttext\nnext')
  })
})
