import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/utils'

export function StarterPanel({
  projectName,
  onSubmit,
}: {
  projectName: string
  onSubmit: (question: string) => Promise<unknown>
}) {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = question.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onSubmit(trimmed)
    } catch (error) {
      toast.error(`创建根节点失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="pointer-events-auto w-full max-w-md rounded-lg border border-line bg-surface/95 p-5 shadow-panel backdrop-blur-sm">
        <h2 className="text-base font-medium text-ink">{projectName}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          第一个问题会成为这棵树的根节点。
        </p>

        <textarea
          value={question}
          autoFocus
          rows={3}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder="例如：什么是特征值？它为什么重要？"
          className="mt-4 w-full resize-none rounded-md border border-line bg-canvas/60 px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-faint">⌘/Ctrl + Enter</span>
          <Button variant="primary" onClick={() => void submit()} disabled={!question.trim() || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            开始
          </Button>
        </div>
      </div>
    </div>
  )
}
