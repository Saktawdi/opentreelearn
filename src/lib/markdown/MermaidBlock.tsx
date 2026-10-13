import { Check, Code2, Copy, Download, Maximize2, Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { renderMermaid } from '@/lib/mermaid'

export function MermaidBlock({ code, ...source }: { code: string } & Record<`data-otl-${string}`, string | undefined>) {
  const { t } = useTranslation('common')
  const [rendered, setRendered] = useState<{ code: string; svg?: string; error?: string } | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    // Avoid running layout for every token while a fenced block is streaming.
    const timer = window.setTimeout(() => {
      void renderMermaid(code).then(
        (svg) => { if (active) setRendered({ code, svg }) },
        (error: unknown) => { if (active) setRendered({ code, error: error instanceof Error ? error.message : String(error) }) },
      )
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [code])

  const current = rendered?.code === code ? rendered : null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch { setCopied(false) }
  }
  const download = () => {
    if (!current?.svg) return
    const url = URL.createObjectURL(new Blob([current.svg], { type: 'image/svg+xml;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'diagram.svg'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const buttonClass = 'rounded-md p-1.5 text-muted hover:bg-elevated hover:text-ink disabled:opacity-40'
  const toolbar = (
    <div className="flex items-center gap-1">
      <button type="button" className={buttonClass} onClick={() => setShowSource(!showSource)} aria-label={t('diagram.source')} aria-pressed={showSource} title={t('diagram.source')}><Code2 className="h-3.5 w-3.5" /></button>
      <button type="button" className={buttonClass} onClick={() => { void copy() }} aria-label={t('copyCode')} title={t('copyCode')}>{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}</button>
      <button type="button" className={buttonClass} onClick={download} disabled={!current?.svg} aria-label={t('diagram.download')} title={t('diagram.download')}><Download className="h-3.5 w-3.5" /></button>
      <button type="button" className={buttonClass} onClick={() => { setZoom(1); setExpanded(true) }} disabled={!current?.svg} aria-label={t('diagram.expand')} title={t('diagram.expand')}><Maximize2 className="h-3.5 w-3.5" /></button>
    </div>
  )

  return (
    <div className="mermaid-block my-3 overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="text-xs text-muted">{t('diagram.title')}</span>
        {toolbar}
      </div>
      {current?.error ? <div role="status" className="px-3 pt-3 text-xs text-danger">{t('diagram.failed')}</div> : null}
      {showSource || current?.error ? (
        <pre className="mermaid-source overflow-auto p-3 text-xs text-ink-soft" {...source}><code>{code}</code></pre>
      ) : current?.svg ? (
        expanded ? <div className="h-40" aria-hidden="true" /> :
        <div className="mermaid-svg overflow-auto p-4" dangerouslySetInnerHTML={{ __html: current.svg }} {...source} data-otl-exact={undefined} />
      ) : <div role="status" className="p-4 text-xs text-muted">{t('diagram.loading')}</div>}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[85vh] w-[min(1200px,100%)] flex-col" aria-describedby={undefined}>
          <DialogTitle>{t('diagram.title')}</DialogTitle>
          <div className="my-2 flex items-center gap-1">
            <button type="button" className={buttonClass} onClick={() => setZoom(Math.max(0.25, zoom - 0.25))} aria-label={t('diagram.zoomOut')}><Minus className="h-4 w-4" /></button>
            <span className="w-12 text-center text-xs text-muted">{Math.round(zoom * 100)}%</span>
            <button type="button" className={buttonClass} onClick={() => setZoom(Math.min(4, zoom + 0.25))} aria-label={t('diagram.zoomIn')}><Plus className="h-4 w-4" /></button>
            <button type="button" className={buttonClass} onClick={() => setZoom(1)} aria-label={t('diagram.reset')}><RotateCcw className="h-4 w-4" /></button>
          </div>
          <div className="mermaid-expanded min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-canvas p-4">
            {current?.svg ? <div className="mermaid-svg" style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: current.svg }} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
