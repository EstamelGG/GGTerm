import { Children, cloneElement, isValidElement, memo, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/**
 * Markdown 渲染（GFM + AT 主题样式），agent 正文 / 用户输入 / 思考内容共用。
 * - 代码块走 --font-mono、可选中、带复制按钮；链接 target=_blank 交给主进程 setWindowOpenHandler 外部打开
 * - decorator：可选的纯文本装饰器（如用户输入的 @mention 高亮），作用于段落内联文本；
 *   code/pre 内保持字面量不装饰
 * - muted：弱化色调（思考内容），正文降为 caption/muted
 */

/** 递归提取 React 子树纯文本（复制代码块用，忽略高亮 span） */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children)
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard
      .writeText(extractText(children))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  return (
    <div className="group relative my-1.5">
      <pre className="select-text overflow-x-auto rounded-md border border-line bg-raised/60 p-2.5 pr-10">
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-caption text-muted opacity-0 transition-opacity duration-150 hover:bg-hover hover:text-fg group-hover:opacity-100"
      >
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  )
}

type TextDecorator = (text: string) => ReactNode

/** 对内联文本应用装饰器；code/pre 保持字面量，不装饰 */
function decorateText(children: ReactNode, deco: TextDecorator): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') return deco(child)
    if (!isValidElement(child)) return child
    if (child.type === 'code' || child.type === 'pre') return child
    const el = child as ReactElement<{ children?: ReactNode }>
    return cloneElement(el, { children: decorateText(el.props.children, deco) })
  })
}

function buildComponents(opts: { decorator?: TextDecorator; muted?: boolean }): Components {
  const fg = opts.muted ? 'text-muted' : 'text-fg'
  const body = opts.muted ? 'text-caption' : 'text-body'
  const wrap = (children: ReactNode): ReactNode =>
    opts.decorator ? decorateText(children, opts.decorator) : children
  return {
    h1: (p) => <h1 className={`mb-2 mt-3 text-title font-semibold ${fg}`} {...p} />,
    h2: (p) => <h2 className={`mb-1.5 mt-3 text-body font-semibold ${fg}`} {...p} />,
    h3: (p) => <h3 className={`mb-1 mt-2.5 text-body font-semibold ${fg}`} {...p} />,
    h4: (p) => <h4 className={`mb-1 mt-2 text-body font-semibold ${fg}`} {...p} />,
    h5: (p) => <h5 className={`mb-1 mt-2 text-minor font-semibold ${fg}`} {...p} />,
    h6: (p) => <h6 className={`mb-1 mt-2 text-minor font-semibold ${fg}`} {...p} />,
    p: (p) => (
      <p className={`my-1 break-words ${body} leading-relaxed ${fg}`} {...p}>
        {wrap(p.children)}
      </p>
    ),
    ul: (p) => (
      <ul className={`my-1 list-disc pl-5 break-words ${body} ${fg}`} {...p}>
        {wrap(p.children)}
      </ul>
    ),
    ol: (p) => (
      <ol className={`my-1 list-decimal pl-5 break-words ${body} ${fg}`} {...p}>
        {wrap(p.children)}
      </ol>
    ),
    li: (p) => (
      <li className="my-0.5" {...p}>
        {wrap(p.children)}
      </li>
    ),
    a: (p) => (
      <a
        className="text-at-accent underline decoration-at-accent/50"
        target="_blank"
        rel="noreferrer"
        {...p}
      />
    ),
    blockquote: (p) => (
      <blockquote className="my-1.5 border-l-2 border-line pl-3 text-muted" {...p} />
    ),
    hr: (p) => <hr className="my-2 border-line" {...p} />,
    pre: CodeBlock,
    code: ({ className, children, ...rest }) =>
      /language-/.test(className ?? '') ? (
        <code
          className={`block whitespace-pre font-mono text-minor ${fg} ${className ?? ''}`}
          {...rest}
        >
          {children}
        </code>
      ) : (
        <code
          className={`break-words rounded bg-raised px-1 py-0.5 font-mono text-minor ${fg}`}
          {...rest}
        >
          {children}
        </code>
      ),
    table: (p) => (
      <table className={`my-1.5 w-full border-collapse break-words text-minor ${fg}`} {...p} />
    ),
    th: (p) => (
      <th
        className="break-words border border-line bg-raised/60 px-2 py-1 text-left font-medium"
        {...p}
      />
    ),
    td: (p) => <td className="break-words border border-line px-2 py-1" {...p} />,
    strong: (p) => (
      <strong className={`font-semibold ${fg}`} {...p}>
        {wrap(p.children)}
      </strong>
    ),
    em: (p) => <em className="italic" {...p} />
  }
}

/** memo：长会话流式更新（如 thinking 增量）时，正文未变化的消息跳过 remark/rehype 全量解析 */
export const Markdown = memo(function Markdown({
  children,
  decorator,
  muted
}: {
  children: string
  /** 纯文本装饰器（如用户输入的 @mention 高亮）；作用于段落/列表的内联文本 */
  decorator?: TextDecorator
  /** 弱化色调（思考内容） */
  muted?: boolean
}): React.JSX.Element {
  const components = useMemo(() => buildComponents({ decorator, muted }), [decorator, muted])
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
      {children}
    </ReactMarkdown>
  )
})
