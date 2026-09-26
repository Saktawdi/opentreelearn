import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { EASE_OUT_EXPO, EXIT_FAST } from '@/lib/motion'
import { errorMessage } from '@/lib/utils'

/**
 * 空白项目的第一个问题入口 —— 产品的门面。
 * 卡片以一次缓出浮现（这是全站唯一的「重场戏」级入场），提交后退场让位给对话。
 */
export function StarterPanel({
  projectName,
  onSubmit,
}: {
  projectName: string
  onSubmit: (question: string) => Promise<unknown>
}) {
  const { t } = useTranslation('canvas')
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = question.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onSubmit(trimmed)
    } catch (error) {
      toast.error(t('starter.createFailed', { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={EXIT_FAST}
      className="pointer-events-none absolute inset-0 flex items-center justify-center p-6"
    >
      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
        className="pointer-events-auto w-full max-w-md rounded-lg border border-line bg-surface/95 p-5 shadow-panel backdrop-blur-sm"
      >
        <h2 className="text-base font-medium text-ink">{projectName}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          {t('starter.intro')}
        </p>

        <textarea
          value={question}
          autoFocus
          rows={3}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            // 与 Composer 一致：Enter 直接发送，Shift+Enter 换行
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={t('starter.placeholder')}
          className="mt-4 w-full resize-none rounded-md border border-line bg-canvas/60 px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-faint">{t('starter.keyHint')}</span>
          <Button variant="primary" onClick={() => void submit()} disabled={!question.trim() || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('starter.start')}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}
