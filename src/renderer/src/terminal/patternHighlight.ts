import type { IDisposable, IMarker, ITerminalAddon, Terminal } from '@xterm/xterm'

export type PatternHighlightRule = {
  id: string
  regex: RegExp
  color: string
  /** 越大越优先，重叠时保留高优先级 */
  priority: number
}

/**
 * 终端语义高亮：场景目录移植自 logalize（github.com/deponian/logalize，MIT）
 * 的 builtins（日期五种形态 / 时长 / logfmt 键值 / 网络地址 / 语义词表），
 * 配色取其 tokyonight-dark 主题（tokyonight.nvim）——patterns 层柔色、words 层亮色。
 */
const T = {
  url: '#82aaff', // 蓝
  addr: '#d266fcff', // 浅紫（IP 地址）
  port: '#0db9d7', // 青（端口 / CIDR）
  teal: '#4fd6be', // 蓝绿（email / 时长）
  uuid: '#86e1fc', // 冰青
  num: '#0db9d7', // 青（纯数字）
  date: '#6af46dff', // 绿色（日期）
  time: '#6af46dff', // 绿色（时间）
  key: '#9aadec', // 蓝紫（logfmt 键）
  err: '#ff757f', // 红
  warn: '#ffc777', // 琥珀
  info: '#82aaff', // 蓝
  good: '#52fa8a', // 亮绿（words 层）
  bad: '#f06c62', // 亮红（words 层）
  dim: '#9aa5ce' // 灰蓝（pid 等弱信息）
} as const

export const DEFAULT_PATTERN_RULES: PatternHighlightRule[] = [
  { id: 'url', priority: 100, color: T.url, regex: /https?:\/\/[^\s<>"'`\]})]+/g },
  {
    id: 'ipv6',
    priority: 90,
    color: T.addr,
    regex:
      /(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|:(?::[0-9a-fA-F]{1,4}){1,7}/g
  },
  {
    id: 'ipv4',
    priority: 85,
    color: T.addr,
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g
  },
  {
    id: 'email',
    priority: 80,
    color: T.teal,
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    id: 'uuid',
    priority: 70,
    color: T.uuid,
    regex:
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g
  },
  // 端口（≥1000，规避 hh:mm 时间误报）/ CIDR 掩码（8/16/24/28/32，规避日期）：
  // 127.0.0.1:8080 的 8080、10.0.0.0/8 的 8（logalize mask-or-port 的保守子集）
  { id: 'port', priority: 50, color: T.port, regex: /(?<=:)\d{4,5}\b|(?<=\/)(?:8|16|24|28|32)\b/g },
  // ls -l 权限串（类型位 + 9 位 rwx 属性，行首）；优先级压过端口/数字类规则
  { id: 'permission', priority: 92, color: T.err, regex: /(?<=^|\s)[-dlbcpsD][rwxsStT-]{9}(?=\s|$)/g },
  // logfmt 键（含等号）：level=info / msg="started" 的键部分
  {
    id: 'logfmt-key',
    priority: 55,
    color: T.key,
    regex: /(?:^|\s)[A-Za-z_][\w.-]*=/g
  },
  // 数字型日期：1999-07-10 / 1999/07/10 / 07-10-1999 / 07/10/1999（logalize date-1）
  {
    id: 'date-num',
    priority: 47,
    color: T.date,
    regex: /\b\d{4}[-/]\d{2}[-/]\d{2}\b|\b\d{2}[-/]\d{2}[-/]\d{4}\b/g
  },
  // 月名-日：Jan 27 / January 27 2023 / Jan-27-2023，含 ls -l 短日期（多空格对齐：Sep  5，
  // 日右对齐补位产生 2 空格；\s{1,2} 不吃整段缩进）（logalize date-3）
  {
    id: 'date-month-day',
    priority: 47,
    color: T.date,
    regex:
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s{1,2}\d{1,2}(?:[\t /-]\d{4})?\b/g
  },
  { id: 'time-hms', priority: 46, color: T.time, regex: /\b\d{2}:\d{2}:\d{2}\b/g },
  // 日志级别词（logalize words 的级别子集；tokens 层柔色）
  {
    id: 'log-error',
    priority: 40,
    color: T.err,
    regex: /\b(?:error|err|fatal|panic|crit(?:ical)?|fail(?:ed|ure)?|denied|invalid|unable|unreachable|timeout)\b/gi
  },
  {
    id: 'log-warn',
    priority: 39,
    color: T.warn,
    regex: /\b(?:warn(?:ing)?|wrn|deprecated|retr(?:y|ies)|skip(?:ped)?|miss(?:ed|ing)?)\b/gi
  },
  {
    id: 'log-info',
    priority: 38,
    color: T.info,
    regex: /\b(?:info|inf|debug|trace|notice)\b/gi
  },
  // 语义词表（logalize words：good/bad；words 层亮色）
  {
    id: 'word-good',
    priority: 36,
    color: T.good,
    regex:
      /\b(?:ok(?:ay)?|online|ready|active|enabled|connected|start(?:ed)?|succeed(?:ed)?|success(?:ful(?:ly)?)?|completed?|loaded|found|opened|listen(?:ing)?|registered?)\b/gi
  },
  {
    id: 'word-bad',
    priority: 35,
    color: T.bad,
    regex: /\b(?:offline|disabled?|stopped|exited?|down|broken|refused|blocked)\b/gi
  },
  { id: 'bool-true', priority: 34, color: T.good, regex: /\b(?:true)\b/gi },
  { id: 'bool-false', priority: 34, color: T.bad, regex: /\b(?:false)\b/gi },
  // 时长（logalize duration，含 µs/d）：5s / 7.5h / 75.98ms / 2d
  {
    id: 'duration',
    priority: 30,
    color: T.teal,
    regex: /\b\d+(?:\.\d+)?(?:µs|ms|s|m|h|d)\b/g
  },
  {
    id: 'pid',
    priority: 25,
    color: T.dim,
    regex: /\bpid[=\s:]?\d+\b/gi
  },
  // 纯数字（最低优先级兜底：日期/端口/时长/pid 等场景优先消费）
  { id: 'number', priority: 20, color: T.num, regex: /\b\d+\b/g }
]

type Span = { start: number; end: number; color: string; priority: number }

type LineEntry = {
  /** cached line content; unchanged content means decorations stay untouched */
  text: string
  marker: IMarker
  decos: IDisposable[]
}

export type PatternHighlightOptions = {
  rules?: PatternHighlightRule[]
  /** 装饰总数量上限，防止长日志卡顿 */
  limit?: number
}

const DEFAULT_LIMIT = 2000
/** max number of decorated lines kept in cache (viewport + scrolled-away) */
const MAX_CACHED_LINES = 2000

/** 预编译后的规则：RegExp 只构造一次（g 标志的 lastIndex 由调用方逐行重置） */
type CompiledRule = { re: RegExp; color: string; priority: number }

function compileRules(rules: PatternHighlightRule[]): CompiledRule[] {
  return rules.map((r) => ({
    re: new RegExp(r.regex.source, r.regex.flags.includes('g') ? r.regex.flags : `${r.regex.flags}g`),
    color: r.color,
    priority: r.priority
  }))
}

function collectSpans(text: string, rules: CompiledRule[]): Span[] {
  const raw: Span[] = []
  for (const rule of rules) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(text))) {
      raw.push({
        start: m.index,
        end: m.index + m[0].length,
        color: rule.color,
        priority: rule.priority
      })
    }
  }
  raw.sort(
    (a, b) => a.start - b.start || b.priority - a.priority || b.end - b.start - (a.end - a.start)
  )
  const out: Span[] = []
  let cursor = 0
  for (const span of raw) {
    if (span.start < cursor) continue
    out.push(span)
    cursor = span.end
  }
  return out
}

export class PatternHighlightAddon implements ITerminalAddon {
  private term: Terminal | null = null
  private rules: CompiledRule[]
  private limit: number
  /** cached per-line decorations, keyed by absolute buffer line */
  private entries = new Map<number, LineEntry>()
  private disposables: IDisposable[] = []
  private scheduled = false
  private disposed = false

  constructor(options: PatternHighlightOptions = {}) {
    this.rules = compileRules(options.rules ?? DEFAULT_PATTERN_RULES)
    this.limit = options.limit ?? DEFAULT_LIMIT
  }

  activate(terminal: Terminal): void {
    this.term = terminal
    this.disposables.push(
      terminal.onWriteParsed(() => this.schedule()),
      terminal.onScroll(() => this.schedule()),
      terminal.onResize(() => this.schedule()),
      terminal.buffer.onBufferChange(() => this.schedule())
    )
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.clear()
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.term = null
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.refresh()
    })
  }

  private disposeEntry(entry: LineEntry): void {
    for (const d of entry.decos) d.dispose()
    entry.marker.dispose()
  }

  private clear(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry)
    this.entries.clear()
  }

  private refresh(): void {
    const term = this.term
    if (!term || this.disposed) return

    const buf = term.buffer.active
    if (buf.type === 'alternate') {
      // alternate screen (vim/htop…) has its own buffer; drop normal-buffer
      // decorations and rebuild when we come back
      this.clear()
      return
    }

    // 1) housekeeping: drop lines trimmed out of scrollback, re-key lines
    //    whose absolute index shifted after buffer trim
    for (const [key, entry] of this.entries) {
      if (entry.marker.isDisposed) {
        this.entries.delete(key)
        this.disposeEntry(entry)
      } else if (entry.marker.line !== key) {
        this.entries.delete(key)
        this.entries.set(entry.marker.line, entry)
      }
    }
    // bound cache size (FIFO eviction)
    while (this.entries.size > MAX_CACHED_LINES) {
      const oldest = this.entries.keys().next().value as number | undefined
      if (oldest === undefined) break
      const entry = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (entry) this.disposeEntry(entry)
    }

    // 扫描窗口跟随"用户视线"（viewportY = ydisp），而非缓冲区底部（baseY）——
    // 否则回滚阅读历史时，新进入视野的行永远不会被扫描（表现为滚上去的内容没有颜色）
    const viewStart = buf.viewportY
    const viewEnd = Math.min(buf.length - 1, viewStart + term.rows - 1)
    const cursorAbs = buf.baseY + buf.cursorY

    // 2) incremental update of the viewport only:
    //    unchanged lines keep their decorations (no flicker on scroll/newline),
    //    changed lines get new decorations registered BEFORE old ones are
    //    disposed so there is never an unhighlighted frame in between
    let decoCount = 0
    for (const entry of this.entries.values()) decoCount += entry.decos.length

    for (let absLine = viewStart; absLine <= viewEnd; absLine++) {
      const line = buf.getLine(absLine)
      if (!line) continue
      const text = line.translateToString(false)
      const existing = this.entries.get(absLine)
      if (existing && existing.text === text) continue // untouched line

      // 空行/达到装饰上限：直接跳过扫描（limit 超限后本行不再装饰）
      const spans = decoCount >= this.limit || text.length === 0 ? [] : collectSpans(text, this.rules)

      // reuse the marker when the line merely changed content
      let marker: IMarker | null = null
      let oldDecos: IDisposable[] = []
      let replacedMarker: IMarker | null = null
      if (existing) {
        if (existing.marker.isDisposed) {
          const m = term.registerMarker(absLine - cursorAbs)
          if (!m || m.line === -1) continue
          marker = m
          replacedMarker = existing.marker
        } else {
          marker = existing.marker
        }
        oldDecos = existing.decos
      } else {
        const m = term.registerMarker(absLine - cursorAbs)
        if (!m || m.line === -1) continue
        marker = m
      }

      // register new decorations first…
      const decos: IDisposable[] = []
      for (const span of spans) {
        if (decoCount >= this.limit) break
        const width = span.end - span.start
        if (width <= 0) continue
        const deco = term.registerDecoration({
          marker,
          x: span.start,
          width,
          foregroundColor: span.color,
          layer: 'bottom'
        })
        if (deco) {
          decos.push(deco)
          decoCount++
        }
      }

      // …then swap in and dispose the old ones within the same frame
      this.entries.set(absLine, { text, marker, decos })
      for (const d of oldDecos) d.dispose()
      replacedMarker?.dispose()
    }
  }
}
