import { Check, Copy } from 'lucide-react'
import { isValidElement, memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { cn } from '@/lib/utils'
import { highlightCode } from './highlighter'

function CodeBlock({ code, language }: { code: string; language?: string }) {
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
        <span className="pointer-events-none absolute right-9 top-2 text-[11px] text-muted/70">
          {language}
        </span>
      ) : null}
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-1.5 rounded-md border border-line/70 bg-canvas/70 p-1 text-muted opacity-0 transition-opacity duration-150 hover:text-ink focus-visible:opacity-100 group-hover/code:opacity-100"
        aria-label="复制代码"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {html ? (
        <div className="shiki-host" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="shiki-fallback">
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

export const MarkdownView = memo(function MarkdownView({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  return (
    <div className={cn('md-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]]}
        components={{
          pre({ children }) {
            const extracted = extractCodeChild(children)
            if (extracted) {
              return <CodeBlock code={extracted.code} language={extracted.language} />
            }
            return <pre>{children}</pre>
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
        {content}
      </ReactMarkdown>
    </div>
  )
})