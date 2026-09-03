/** 剥除 ANSI CSI/OSC 与其它控制序列（保留换行/制表；归一化 CRLF）。 */
export function stripAnsi(text: string): string {
  // 终端协议以控制字符为分隔符；OSC 必须停在第一个 BEL/ST，不能吞掉后续正文。
  /* eslint-disable no-control-regex */
  return text
    .replace(/\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI（含冒号分隔的颜色参数）
    .replace(/\u001b[@-Z\\-_]/g, '') // 单字符 ESC 序列
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/g, '')
    .replace(/\r\n?/g, '\n')
  /* eslint-enable no-control-regex */
}
