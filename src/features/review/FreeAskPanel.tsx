import { CornerDownLeft, Loader2, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { Id } from '@/domain/models'
import { stripStreamingReviewRating } from '@/domain/review/protocol'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { formatRelativeTime } from '@/lib/time'
import { imagesFromClipboard } from '@/services/images'
import { Button } from '@/components/ui/button'
import { ComposerShell } from '@/features/chat/ComposerShell'
import { ToolActivities } from '@/features/chat/ToolActivities'
import { useFreeAskStore } from '@/stores/free-ask-store'
import { useAssetUrls } from '@/features/chat/useAssetUrls'

interface FreeAskPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: Id
  hasChatModel: boolean
}

/** 空态的三句起手式：都是「快速回忆今天 / 安排下一步」的问题，而不是知识问答。 */
// `as const` 是必需的：丢了字面量类型就退化成 string[]，t() 的严格键校验会报错
const STARTER_KEYS = [
  'freeAsk.starterToday',
  'freeAsk.starterFading',
  'freeAsk.starterNext',
] as const

/** 一条用户问句里的图片：走资产表解析 dataUrl（与聊天消息同一套解析）。 */
function MessageImages({ imageIds }: { imageIds: Id[] }) {
  const { t } = useTranslation('review')
  const imageUrls = useAssetUrls(imageIds.join(','))
  if (imageIds.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {imageIds.map((id) => {
        const url = imageUrls[id]
        return url ? (
          <img
            key={id}
            src={url}
            alt={t('freeAsk.pendingImageAlt')}
            className="max-h-48 rounded-md border border-line/60"
          />
        ) : null      })}
    </div>
  )
}

/**
 * 复习工作区的「自由问答」面板。
 *
 * 补上的是这个位置缺的那件事：复习工作区是点击式的（概览 → 练习 → 反馈 → 小结），
 * 而「睡前问一句今天学了什么」不需要走一遍练习流程。上下文由 `domain/context/free-ask`
 * 组装（复习中心规则 + 实时学习快照 + 项目主题清单），面板只负责把问答显示清楚。
 *
 * 三条纪律写在界面上，不只是写在代码里：不写入任何节点、不影响复习排期、问答不落库。
 * 用户需要知道随口问一句不会改变他的学习数据。
 *
 * 输入框复用对话页的 `ComposerShell`（同一套 Enter 发送、自适应高度与发送/停止按钮）；
 * 草稿跟着对话留在 store 内存里，关掉面板再回来还在，与「刷新即清空」的会话同进退。
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
  const draft = useFreeAskStore((state) => state.draft)
  const setDraft = useFreeAskStore((state) => state.setDraft)
  const pendingImages = useFreeAskStore((state) => state.pendingImages)
  const attachImages = useFreeAskStore((state) => state.attachImages)
  const removePendingImage = useFreeAskStore((state) => state.removePendingImage)

  const bottomRef = useRef<HTMLDivElement>(null)

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
  // 纯图片提问合法（贴张板书拍照问一句）：正文与图片至少有一头
  const canSend =
    hasChatModel && (draft.trim().length > 0 || pendingImages.length > 0) && !isStreaming

  const submit = (question: string) => {
    if (!hasChatModel || isStreaming) return
    // 纯图片提问合法：正文为空但有待发图片也放行（ask 里会守住「两头都空」）
    if (!question.trim() && pendingImages.length === 0) return
    // 输入框归零由 store 在收下提问时完成（发送失败也该让提问留在对话里）
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
                <>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">
                    {message.text}
                  </p>
                  {(message.imageIds?.length ?? 0) > 0 ? <MessageImages imageIds={message.imageIds!} /> : null}
                </>
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

        {/* 输入区：与对话页同一只框（ComposerShell），Enter 发送、Shift+Enter 换行、图片粘贴/拖放 */}
        <div>
          {hasChatModel ? (
            <ComposerShell
              draft={{
                text: draft,
                setText: setDraft,
                pending: pendingImages,
                removePending: removePendingImage,
                attachFiles: attachImages,
              }}
              onPaste={(event) => {
                const files = imagesFromClipboard(event.nativeEvent as ClipboardEvent)
                if (files.length > 0) {
                  event.preventDefault()
                  void attachImages(files)
                }
              }}
              onSubmit={() => submit(draft)}
              canSubmit={canSend}
              streaming={isStreaming}
              onStop={cancel}
              placeholder={t('freeAsk.placeholder')}
              toolbar={
                <span className="flex min-w-0 items-center gap-2 px-1 text-2xs text-faint">
                  <span className="flex shrink-0 items-center gap-1">
                    <CornerDownLeft className="h-3 w-3" />
                    {t('freeAsk.enterHint')}
                  </span>
                  {contextNote ? (
                    <span className="truncate text-muted" title={contextNote}>
                      {contextNote}
                    </span>
                  ) : null}
                </span>
              }
            />
          ) : (
            <p className="border-t border-line/60 p-4 text-xs text-muted">
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