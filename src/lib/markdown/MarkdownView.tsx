import { Check, Copy } from 'lucide-react'
import { isValidElement, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import { useTranslation } from 'react-i18next'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { cn } from '@/lib/utils'
import { highlightCode } from './highlighter'
import { normalizeDisplayMath } from './math-fences'
import { rehypeSourceMap } from './source-map'

/** rehype 插件表的类型：从 react-markdown 的 Options 里取，避免直接依赖 unified 的类型。 */
type RehypePlugins = NonNullable<Options['rehypePlugins']>

function CodeBlock({
  code,
  language,
  ...source
}: {
  code: string
  language?: string
} & SourceProps) {
  const { t } = useTranslation('common')
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    void highlightCode(code, language)
      .then((result) => {
        if (active) setHtml(result)
      })
      .catch(() => {
        if (active) setHtml(null)
      })
    return () => {
      active = false
    }
  }, [code, language])

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  return (
    <div className="code-shell group/code relative">
      {language ? (
        <span className="pointer-events-none absolute right-9 top-2 text-2xs text-faint">
          {language}
        </span>
      ) : null}
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-1.5 rounded-md border border-line/70 bg-canvas/70 p-1 text-muted opacity-0 transition-opacity duration-150 hover:text-ink focus-visible:opacity-100 group-hover/code:opacity-100"
        aria-label={t('copyCode')}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {/* 源文区间挂在**只包住代码**的这一层：语言标签与复制按钮的文字不能算进去，
          否则单位文字与源码就对不上了（见 note-anchor.ts 的精确单位核对） */}
      {html ? (
        <div className="shiki-host" dangerouslySetInnerHTML={{ __html: html }} {...source} />
      ) : (
        <pre className="shiki-fallback" {...source}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

function extractCodeChild(children: ReactNode): { code: string; language?: string } | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement(child)) return null
  const props = child.props as { className?: string; children?: ReactNode }
  const raw = typeof props.children === 'string' ? props.children : String(props.children ?? '')
  if (!raw) return null
  const language = /language-([\w-]+)/.exec(props.className ?? '')?.[1]
  return { code: raw.replace(/\n$/, ''), language }
}

/** 源文区间属性（`data-otl-src` 等），由 rehype 插件写在代码块上，这里原样转交 DOM。 */
type SourceProps = Record<`data-otl-${string}`, string | undefined>

export const MarkdownView = memo(function MarkdownView({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  // 规范化只依赖原文：流式渲染每帧都会进来，缓存住避免重复扫全文
  const normalized = useMemo(() => normalizeDisplayMath(content), [content])

  // 源文标注必须排在 rehype-katex **之前**：KaTeX 会把公式元素整个换成排版结果，
  // 之后再挂就找不到它了（见 source-map.ts）
  const rehypePlugins = useMemo(
    () =>
      [
        [rehypeSourceMap, normalized],
        [rehypeKatex, { throwOnError: false, strict: false, output: 'html' }],
      ] as unknown as RehypePlugins,
    [normalized],
  )

  return (
    <div className={cn('md-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins}
        components={{
          pre({ children, node, ...props }) {
            // `node` 是 react-markdown 附带的 hast 节点，这里只为把它挡在 DOM 之外
            void node
            const extracted = extractCodeChild(children)
            if (extracted) {
              return (
                <CodeBlock
                  code={extracted.code}
                  language={extracted.language}
                  {...(props as SourceProps)}
                />
              )
            }
            return <pre {...props}>{children}</pre>
          },
          a({ href, children, ...props }) {
            return (
              <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
                {children}
              </a>
            )
          },
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
})