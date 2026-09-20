import { ArrowRight, Loader2 } from 'lucide-react'
import { motion } from 'motion/react'
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
      toast.error(`创建起始节点失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="pointer-events-auto w-full max-w-lg rounded-2xl border border-line bg-surface/95 p-6 shadow-panel backdrop-blur"
      >
        <p className="text-[11.5px] uppercase tracking-wide text-muted">起始节点</p>
        <h2 className="mt-1.5 text-[16px] font-semibold text-ink">{projectName}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          提出第一个问题，它会成为这棵学习树的根节点；之后你可以从任意一条回答里发散出新的支线。
        </p>

        <div className="mt-5 space-y-3">
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
            className="w-full resize-none rounded-xl border border-line bg-canvas/60 px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] text-muted/80">⌘/Ctrl + Enter 发送</span>
            <Button variant="primary" onClick={() => void submit()} disabled={!question.trim() || busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              开始学习
              {!busy ? <ArrowRight className="h-4 w-4" /> : null}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}