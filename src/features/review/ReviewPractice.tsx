import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  ChevronRight,
  HelpCircle,
  Lightbulb,
  Loader2,
  RefreshCw,
  RotateCcw,
  SkipForward,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { NodeReview, ReviewGrade } from '@/domain/models'
import type { ReviewRequestPurpose, ReviewSessionItem } from '@/domain/review/session'
import { currentOpenQuestion, latestQuestion } from '@/domain/review/delivery'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { stripReviewRating, stripStreamingReviewRating } from '@/domain/review/protocol'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ReviewFeedback } from './ReviewFeedback'

/** 非题目区消息的标签：复述题、换问法都是「题」，不能混进「反馈」。 */
const OTHER_MESSAGE_LABEL: Partial<Record<ReviewRequestPurpose, string>> = {
  question: '复述题',
  hint: '提示',
  rephrase: '换个问法',
}

interface ReviewPracticeProps {
  item: ReviewSessionItem
  scoreBefore: number
  reviewBefore?: NodeReview
  isLastItem: boolean
  streamingText?: string
  streamingPurpose?: string
  streamingDelivered?: boolean
  streamingActivities?: Array<{ name: string; label: string }>
  lastUndoneNotice?: string | null
  undoable: boolean
  onSaveDraft: (draft: string) => void
  onSubmitAnswer: (answer: string) => void
  onRequestHint: () => void
  onRequestRephrase: () => void
  onRequestGiveUp: () => void
  onConfirmRelearnReady: () => void
  onSelectGrade: (grade: ReviewGrade) => void
  onConfirmGrade: () => void
  onSkip: () => void
  onUndoLast: () => void
  onToggleSource: () => void
  onRetry: () => void
}

/**
 * 复习练习主舞台：
 * - 覆盖：准备题目、回忆、补学、正在反馈、反馈与评分、保存中全阶段；
 * - 自动聚焦输入区与题目，避免流式时反复抢焦点；
 * - 中文输入法组合态防护，防止误提交；
 * - 清晰展示做对处、待补充处与评分器；
 * - 撤销上次评分后常驻可点提示条。
 */
export function ReviewPractice({
  item,
  scoreBefore,
  reviewBefore,
  isLastItem,
  streamingText,
  streamingPurpose,
  streamingDelivered,
  streamingActivities,
  lastUndoneNotice,
  undoable,
  onSaveDraft,
  onSubmitAnswer,
  onRequestHint,
  onRequestRephrase,
  onRequestGiveUp,
  onConfirmRelearnReady,
  onSelectGrade,
  onConfirmGrade,
  onSkip,
  onUndoLast,
  onToggleSource,
  onRetry,
}: ReviewPracticeProps) {
  const [draft, setDraft] = useState(item.draft ?? '')
  const [prevItemId, setPrevItemId] = useState(item.itemId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)

  // 状态根据 item.itemId 切换而在 render 期间校准，避免在 effect 内部调用 setState
  if (item.itemId !== prevItemId) {
    setPrevItemId(item.itemId)
    setDraft(item.draft ?? '')
  }

  // 当进入回忆作答时自动聚焦输入框
  useEffect(() => {
    if (item.phase === 'answering' && !streamingText) {
      textareaRef.current?.focus()
    }
  }, [item.phase, streamingText])

  const handleDraftChange = (val: string) => {
    setDraft(val)
    onSaveDraft(val)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isComposingRef.current) {
      e.preventDefault()
      if (draft.trim() && item.phase === 'answering') {
        onSubmitAnswer(draft)
      }
    }
  }

  const isPreparing = item.phase === 'preparing'
  const isRelearning = item.phase === 'relearning'
  const isAnswering = item.phase === 'answering'
  const isEvaluating = item.phase === 'evaluating'
  const isFeedback = item.phase === 'feedback'
  const isSaving = item.phase === 'saving'

  // 题目卡渲染「当前题」：开放题优先，否则（补学的讲解卡 / 尚未出题）退到最新题。
  // 与交付守卫共用同一个不变量 —— 换问法后当前题指针后移，旧题沉入下方历史区。
  const relearnMessage =
    item.mode === 'relearn'
      ? item.messages.find((m) => m.role === 'assistant' && m.purpose === 'relearn')
      : undefined
  const questionMessage =
    currentOpenQuestion(item) ?? (item.mode === 'relearn' ? relearnMessage : null) ?? latestQuestion(item)

  // 伴随的其它交互消息（提示、换问法、用户回答、反馈等）
  const otherMessages = item.messages.filter((m) => m !== questionMessage)

  // 补学确认后、复述题尚未到达的空窗（在途 / 失败 / 刷新中断）。确认点击的那一刻
  // 阶段就进了 answering，若不给这段空窗自己的加载态，用户会把补学卡片结尾的
  // 「请复述…」当成题目开始打字，题目生成完又突然插进来一张卡。
  const isRelearnAwaitingQuestion =
    item.mode === 'relearn' &&
    isAnswering &&
    !item.messages.some((m) => m.role === 'assistant' && m.purpose === 'question')
  const isFollowUpStreaming = isRelearnAwaitingQuestion && streamingPurpose === 'question'

  // 提示 / 换问法在途：给流式占位让用户看得到动静，同时禁掉会重复发起请求的按钮 ——
  // 否则界面毫无反应，用户只会连点（可用性反馈 2026-09）。产物一旦落位（delivered）
  // 旁白就让位给正式卡片。
  const isAssistStreaming =
    isAnswering &&
    !streamingDelivered &&
    (streamingPurpose === 'hint' || streamingPurpose === 'rephrase')

  // 检索活动行：模型这一轮查了什么，一行轻量展示（交付工具不计入）
  const activityLabel = streamingActivities?.length
    ? streamingActivities.map((activity) => activity.label).join(' · ')
    : null

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-8 max-w-4xl mx-auto w-full">
      {/* 撤销提示横幅 */}
      {undoable && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-line/60 bg-surface px-3 py-2 text-xs text-muted">
          <span>{lastUndoneNotice ?? '已记录上一项评分'}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onUndoLast}
            className="h-6 text-accent hover:text-accent/80"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            撤销上次评分
          </Button>
        </div>
      )}

      {/* 错误警告与重试 */}
      {item.error ? (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-danger/40 bg-danger-soft/20 px-3 py-2 text-xs text-danger">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{item.error}</span>
          </div>
          <Button variant="secondary" size="sm" onClick={onRetry} className="h-6">
            <RefreshCw className="mr-1 h-3 w-3" />
            重试
          </Button>
        </div>
      ) : null}

      {/* 题目展示区 */}
      <div className="rounded-xl border border-line/70 bg-surface p-5 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-2xs font-medium text-accent">
            {item.mode === 'relearn' ? '关键点补学' : '主动回忆题'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleSource}
            className="h-6 text-2xs text-muted hover:text-ink gap-1"
          >
            <BookOpen className="h-3 w-3" />
            查看原资料
          </Button>
        </div>

        {isPreparing && !questionMessage ? (
          <div className="py-6 text-xs text-muted">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              <span>正在为你准备{item.mode === 'relearn' ? '补学关键点' : '回忆题目'}…</span>
            </div>
            {activityLabel ? <div className="mt-1.5 pl-6 text-2xs text-faint">{activityLabel}</div> : null}
          </div>
        ) : questionMessage ? (
          <div className="text-sm leading-relaxed text-ink">
            <MarkdownView content={stripReviewRating(questionMessage.text)} />
          </div>
        ) : streamingPurpose === 'question' || streamingPurpose === 'relearn' ? (
          <div className="text-sm leading-relaxed text-ink">
            <MarkdownView content={stripStreamingReviewRating(streamingText ?? '')} />
          </div>
        ) : null}

        {/* 补学阶段确认按钮 */}
        {isRelearning && (
          <div className="mt-4 border-t border-line/40 pt-4 flex justify-end">
            <Button variant="primary" size="sm" onClick={onConfirmRelearnReady}>
              准备好了，试着复述
              <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        )}
      </div>

      {/* 补充对话记录（提示、用户回答、反馈） */}
      {otherMessages.length > 0 && (
        <div className="mt-5 space-y-4">
          {otherMessages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-lg border p-4 text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'border-accent/30 bg-accent-soft/20 text-ink ml-8'
                  : 'border-line/60 bg-surface text-ink-soft mr-8'
              }`}
            >
              <div className="mb-1 text-2xs text-faint">
                {msg.role === 'user' ? '我的回答' : (OTHER_MESSAGE_LABEL[msg.purpose] ?? '反馈')}
              </div>
              <MarkdownView content={stripReviewRating(msg.text)} />
            </div>
          ))}
        </div>
      )}

      {/* 复述题生成中：骨架与流式就位在题目将落成的同一位置，生成完原地变成「复述题」卡片。
          失败时不渲染这张卡 —— 顶部错误横幅已带重试入口。 */}
      {isRelearnAwaitingQuestion && (isFollowUpStreaming || !item.error) && (
        <div className="mt-5 rounded-lg border border-line/60 bg-surface p-4 text-xs leading-relaxed text-ink-soft mr-8">
          {isFollowUpStreaming ? (
            <>
              <div className="mb-1 flex items-center gap-1.5 text-2xs text-accent">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>正在出复述题…</span>
              </div>
              {activityLabel ? <div className="mb-1 text-2xs text-faint">{activityLabel}</div> : null}
              {streamingText ? (
                <MarkdownView content={stripStreamingReviewRating(streamingText)} />
              ) : null}
            </>
          ) : (
            /* 刷新 / 暂停后请求丢了：不自动重发（重发等于替用户再付一次调用），给手动重试 */
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">复述题没有生成出来。</span>
              <Button variant="secondary" size="sm" onClick={onRetry} className="h-6">
                <RefreshCw className="mr-1 h-3 w-3" />
                重新生成
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 提示 / 换问法生成中：占位与流式就位在消息将落成的同一位置，落地后原地变成对应卡片 */}
      {isAssistStreaming && (
        <div className="mt-5 rounded-lg border border-line/60 bg-surface p-4 text-xs leading-relaxed text-ink-soft mr-8">
          <div className="mb-1 flex items-center gap-1.5 text-2xs text-accent">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{streamingPurpose === 'hint' ? '正在给一点提示…' : '正在换个问法…'}</span>
          </div>
          {activityLabel ? <div className="mb-1 text-2xs text-faint">{activityLabel}</div> : null}
          {streamingText ? (
            <MarkdownView content={stripStreamingReviewRating(streamingText)} />
          ) : null}
        </div>
      )}

      {/* 正在生成反馈流式展示 */}
      {isEvaluating && (
        <div className="mt-4 rounded-lg border border-line/60 bg-surface p-4 text-xs leading-relaxed text-muted mr-8">
          <div className="mb-1 flex items-center gap-1.5 text-2xs text-accent">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>正在生成反馈…</span>
          </div>
          {streamingText ? (
            <MarkdownView content={stripStreamingReviewRating(streamingText)} />
          ) : null}
        </div>
      )}

      {/* 回忆作答输入区：复述题在途时先不出现，题目落成后随自动聚焦一起就位 */}
      {isAnswering && !isRelearnAwaitingQuestion && (
        <div className="mt-5 rounded-xl border border-line/70 bg-surface p-4 shadow-sm">
          <label htmlFor="review-answer-input" className="block mb-2 text-xs font-medium text-ink">
            我的回答
          </label>
          <Textarea
            id="review-answer-input"
            ref={textareaRef}
            rows={4}
            value={draft}
            disabled={isEvaluating}
            onChange={(e) => handleDraftChange(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false
            }}
            onKeyDown={handleKeyDown}
            placeholder="用自己的话简述答案，或写下回忆出的关键点… (Ctrl+Enter 发送)"
            className="w-full text-xs leading-relaxed"
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                disabled={isAssistStreaming}
                onClick={onRequestHint}
                title="回忆卡住时，看一点小提示"
                className="text-2xs text-muted hover:text-ink disabled:opacity-50"
              >
                <Lightbulb className="mr-1 h-3.5 w-3.5" />
                给一点提示
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isAssistStreaming}
                onClick={onRequestRephrase}
                title="换一种表达方式重新问"
                className="text-2xs text-muted hover:text-ink disabled:opacity-50"
              >
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                换个问法
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRequestGiveUp}
                title="实在想不起来，直接看讲解并自评"
                className="text-2xs text-muted hover:text-ink"
              >
                <HelpCircle className="mr-1 h-3.5 w-3.5" />
                暂时想不起来
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSkip}
                className="text-2xs text-faint hover:text-ink"
              >
                <SkipForward className="mr-1 h-3.5 w-3.5" />
                跳过
              </Button>
            </div>

            <Button
              variant="primary"
              size="sm"
              disabled={!draft.trim() || isEvaluating}
              onClick={() => onSubmitAnswer(draft)}
            >
              提交回答
            </Button>
          </div>
        </div>
      )}

      {/* 反馈与自评区 */}
      {(isFeedback || isSaving) && (
        <div className="mt-5 space-y-4">
          <ReviewFeedback
            item={item}
            scoreBefore={scoreBefore}
            reviewBefore={reviewBefore}
            selectedGrade={item.selectedGrade}
            onSelectGrade={onSelectGrade}
            disabled={isSaving}
          />

          <div className="flex items-center justify-between border-t border-line/60 pt-4">
            <div className="text-2xs text-muted">
              {item.usedHint ? '本次参考过提示 · ' : ''}
              {item.usedSource ? '本次查看过资料 · ' : ''}
              点击确认后将更新复习排期
            </div>
            <Button
              variant="primary"
              size="md"
              disabled={isSaving}
              onClick={onConfirmGrade}
              className="gap-1.5"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  保存中…
                </>
              ) : (
                <>
                  {isLastItem ? '确认并查看小结' : '确认并继续'}
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}