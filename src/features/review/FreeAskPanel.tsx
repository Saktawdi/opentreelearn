import { CornerDownLeft, Loader2, Send, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { Id } from '@/domain/models'
import { stripStreamingReviewRating } from '@/domain/review/protocol'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { formatRelativeTime } from '@/lib/time'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ToolActivities } from '@/features/chat/ToolActivities'
import { useFreeAskStore } from '@/stores/free-ask-store'

interface FreeAskPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: Id
  hasChatModel: boolean
}

/** 空态的三句起手式：都是「快速回忆今天 / 安排下一步」的问题，而不是知识问答。 */
const STARTER_KEYS = ['freeAsk.starterToday', 'freeAsk.starterFading', 'freeAsk.starterNext']

/**
 * 复习工作区的「自由问答」面板。
 *
 * 补上的是这个位置缺的那件事：复习工作区是点击式的（概览 → 练习 → 反馈 → 小结），
 * 而「睡前问一句今天学了什么」不需要走一遍练习流程。上下文由 `domain/context/free-ask`
 * 组装（复习中心规则 + 实时学习快照 + 项目主题清单），面板只负责把问答显示清楚。
 *
 * 三条纪律写在界面上，不只是写在代码里：不写入任何节点、不影响复习排期、问答不落库。
 * 用户需要知道随口问一句不会改变他的学习数据。
 */
export function FreeAskPanel({ open, onOpenChange, projectId, hasChatModel }: FreeAskPanelProps) {
  const { t } = useTranslation('review')
  const messages = useFreeAskStore((state) => state.messages)
  const streaming = useFreeAskStore((state) => state.streaming)
  const error = useFreeAskStore((state) => state.error)
  const contextNote = useFreeAskStore((state) => state.contextNote)
  const ask = useFreeAskStore((state) => state.ask)
  const cancel = useFreeAskStore((state) => state.cancel)
  const reset = useFreeAskStore((state) => state.reset)
  const syncProject = useFreeAskStore((state) => state.syncProject)

  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)

  // 换项目即丢弃上一段对话：回答里全是上个项目的主题标题，留着比丢掉更糟
  useEffect(() => {
    if (open) syncProject(projectId)
  }, [open, projectId, syncProject])

  // 按 Esc 关闭（与资料抽屉一致）
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onOpenChange])

  const streamingText = useMemo(
    () => (streaming ? stripStreamingReviewRating(streaming.text) : ''),
    [streaming],
  )

  useEffect(() => {
    if (!open) return
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [open, messages.length, streamingText, error])

  if (!open) return null

  const isStreaming = Boolean(streaming)
  const canSend = hasChatModel && draft.trim().length > 0 && !isStreaming

  const submit = (question: string) => {
    if (!hasChatModel || isStreaming) return
    if (!question.trim()) return
    setDraft('')
    void ask(question)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="flex h-[80vh] w-full max-w-3xl flex-col rounded-2xl border border-line bg-surface shadow-panel">
        {/* 头部 */}
        <div className="flex items-start justify-between gap-3 border-b border-line/60 p-5 pb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 shrink-0 text-accent" />
              <h2 className="text-base font-semibold text-ink">{t('freeAsk.title')}</h2>
            </div>
            <p className="mt-1 text-2xs text-muted">
              {t('freeAsk.subtitle')}
              <span className="text-faint">{t('freeAsk.subtitleNote')}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {messages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={reset}
                className="text-2xs text-faint hover:text-ink gap-1"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('freeAsk.clearConversation')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onOpenChange(false)}
              aria-label={t('freeAsk.close')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 对话区 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {messages.length === 0 && !isStreaming ? (
            <div className="py-8 text-center">
              <Sparkles className="mx-auto mb-3 h-7 w-7 text-accent/70" />
              <p className="text-xs text-muted">{t('freeAsk.emptyHint')}</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {STARTER_KEYS.map((starterKey) => {
                  const starter = t(starterKey)
                  return (
                    <button
                      key={starterKey}
                      type="button"
                      onClick={() => submit(starter)}
                      disabled={!hasChatModel}
                      className="rounded-full border border-line bg-elevated/60 px-3 py-1.5 text-2xs text-ink-soft transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-45"
                    >
                      {starter}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-xl border p-3.5 ${
                message.role === 'assistant'
                  ? 'border-line/60 bg-elevated/40'
                  : 'border-accent/20 bg-accent-soft/30'
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between text-2xs text-faint">
                <span>{message.role === 'assistant' ? t('roles.mentor') : t('roles.learner')}</span>
                <span>{formatRelativeTime(message.createdAt)}</span>
              </div>
              {message.role === 'assistant' ? (
                <MarkdownView content={message.text} />
              ) : (
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
                  {message.text}
                </p>
              )}
              {message.incomplete ? (
                <p className="mt-2 text-2xs text-faint">{t('freeAsk.incomplete')}</p>
              ) : null}
            </div>
          ))}

          {/* 流式回答：正文用与落库前一致的剥离规则，避免判定标记一闪而过 */}
          {streaming ? (
            <div className="rounded-xl border border-line/60 bg-elevated/40 p-3.5">
              <div className="mb-1.5 flex items-center justify-between text-2xs text-faint">
                <span>{t('roles.mentor')}</span>
                <span className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {streaming.tools.length > 0
                    ? t('freeAsk.queryingProject')
                    : t('freeAsk.queryingRecords')}
                </span>
              </div>
              {streaming.tools.length > 0 ? (
                <div className="mb-2">
                  <ToolActivities tools={streaming.tools} />
                </div>
              ) : null}
              {streamingText ? (
                <MarkdownView content={streamingText} />
              ) : (
                <p className="text-xs text-faint">{t('freeAsk.generating')}</p>
              )}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-xl border border-danger/30 bg-danger-soft/40 p-3 text-2xs text-danger">
              {error}
              <span className="ml-2 text-faint">{t('freeAsk.errorHint')}</span>
            </div>
          ) : null}

          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className="border-t border-line/60 p-4">
          {hasChatModel ? (
            <>
              <Textarea
                rows={3}
                value={draft}
                disabled={isStreaming}
                onChange={(e) => setDraft(e.target.value)}
                onCompositionStart={() => {
                  isComposingRef.current = true
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false
                }}
                onKeyDown={(e) => {
                  // 聊天框的惯例：Enter 发送、Shift+Enter 换行（与主对话一致）
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    if (canSend) submit(draft)
                  }
                }}
                placeholder={t('freeAsk.placeholder')}
                className="text-xs"
              />
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-2xs text-faint">
                  <span className="flex items-center gap-1">
                    <CornerDownLeft className="h-3 w-3" />
                    {t('freeAsk.enterHint')}
                  </span>
                  {contextNote ? <span className="text-muted">{contextNote}</span> : null}
                </span>

                {isStreaming ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={cancel}
                    className="gap-1.5 text-2xs"
                  >
                    <Square className="h-3 w-3" />
                    {t('freeAsk.stop')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!canSend}
                    onClick={() => submit(draft)}
                    className="gap-1.5 text-2xs"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {t('freeAsk.send')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">
              {t('freeAsk.noModelBefore')}{' '}
              <Link to="/settings" className="text-accent underline underline-offset-4">
                {t('freeAsk.noModelLink')}
              </Link>{' '}
              {t('freeAsk.noModelAfter')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}