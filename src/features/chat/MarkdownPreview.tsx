import { Eye, EyeOff } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { cn } from '@/lib/utils'
import { useThrottledValue } from './useThrottledValue'

/** 编辑区保留 Markdown 源码，预览与消息共用公式、代码和图表渲染。 */
export function MarkdownPreview({ content, className }: { content: string; className?: string }) {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(true)
  const id = useId()
  const preview = useThrottledValue(content, 100)

  if (!content.trim()) return null

  return (
    <div className={cn('min-w-0 border-t border-line/50', className)}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1.5 rounded-sm px-1 py-1.5 text-2xs text-muted transition-colors hover:text-ink"
      >
        {expanded ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        {t(expanded ? 'composer.hidePreview' : 'composer.showPreview')}
      </button>
      <div id={id} hidden={!expanded} className="max-h-[180px] overflow-auto pb-2">
        {expanded ? <MarkdownView content={preview} /> : null}
      </div>
    </div>
  )
}
