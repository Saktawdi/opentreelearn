import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  ChevronRight,
  HelpCircle,
  ImagePlus,
  Lightbulb,
  Loader2,
  RefreshCw,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Asset, Id, NodeReview, ReviewGrade } from '@/domain/models'
import type {
  ReviewRequestPurpose,
  ReviewSessionItem,
  ReviewSessionMessage,
} from '@/domain/review/session'
import { currentOpenQuestion, latestQuestion } from '@/domain/review/delivery'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { stripReviewRating, stripStreamingReviewRating } from '@/domain/review/protocol'
import { getRepositories } from '@/data'
import { createImageAsset, imagesFromClipboard } from '@/services/images'
import { errorMessage } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { SelectionAction } from '@/features/chat/SelectionMenu'
import { SelectionMenu } from '@/features/chat/SelectionMenu'
import { MessageNotes } from '@/features/chat/MessageNotes'
import { useAssetUrls } from '@/features/chat/useAssetUrls'
import { ReviewAnnotatableText } from './ReviewAnnotatable'
import { useReviewMessageNotes } from './use-review-notes'
import { ReviewFeedback } from './ReviewFeedback'

/** 非题目区消息的标签：复述题、换问法都是「题」，反馈轮里的补讲标「补学」，不能混进「反馈」。 */
const OTHER_MESSAGE_LABEL: Partial<Record<ReviewRequestPurpose, string>> = {
  question: '复述题',
  hint: '提示',
  rephrase: '换个问法',
  relearn: '补学',
}

/** 用户消息自己的标签（回答 vs 追问）。 */
function userMessageLabel(purpose: ReviewRequestPurpose): string {
  return purpose === 'followup' ? '追问' : '我的回答'
}

interface ReviewPracticeProps {
  projectId: Id
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
  onSubmitAnswer: (answer: string, imageIds?: Id[]) => void
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
  /** 就标记的内容追问（划选菜单「就这段追问」的落地动作） */
  onAskFollowup: (question: string) => void
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
  projectId,
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
  onAskFollowup,
}: ReviewPracticeProps) {
  const [draft, setDraft] = useState(item.draft ?? '')
  const [prevItemId, setPrevItemId] = useState(item.itemId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)
  /** 划选「就这段追问」拉起的追问输入（quote 是框选到的原文，随文本一起提交） */
  const [followup, setFollowup] = useState<{ quote: string; text: string } | null>(null)
  const followupRef = useRef<HTMLTextAreaElement>(null)
  const followupComposingRef = useRef(false)
  /** 待提交的作答图片：粘贴 / 上传进来，提交时才落 assets（与聊天输入框同一套时序） */
  const [pendingImages, setPendingImages] = useState<Array<{ asset: Asset; url: string }>>([])
  const pendingImagesRef = useRef<Array<{ asset: Asset; url: string }>>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 状态根据 item.itemId 切换而在 render 期间校准，避免在 effect 内部调用 setState
  if (item.itemId !== prevItemId) {
    setPrevItemId(item.itemId)
    setDraft(item.draft ?? '')
    // 换主题时待提交图片一并作废：草稿不跨主题，图片也不该悄悄跟过去。
    // 这里读到的是本 render 的 state（旧图片还在里面），回收后清空 —— 不经 ref。
    for (const pending of pendingImages) URL.revokeObjectURL(pending.url)
    setPendingImages([])
  }

  // 阶段切换时收起追问输入：同样在 render 期间校准 —— 离开可追问的稳定态，
  // 输入框就不再有提交落点（确认评分、评分中都不是提问的时机）
  const [prevPhase, setPrevPhase] = useState(item.phase)
  if (item.phase !== prevPhase) {
    setPrevPhase(item.phase)
    if (followup && item.phase !== 'feedback' && item.phase !== 'relearning') {
      setFollowup(null)
    }
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
      if ((draft.trim() || pendingImages.length > 0) && item.phase === 'answering') {
        void submitAnswer()
      }
    }
  }

  /** 划选「引用到对话」在复习里的落点：并进回答草稿（与学习对话的引用同构） */
  const quoteToDraft = (text: string) => {
    const next = draft.trim() ? `${draft.trimEnd()}\n${text}` : text
    setDraft(next)
    onSaveDraft(next)
    textareaRef.current?.focus()
  }

  const submitFollowup = () => {
    const question = followup?.text.trim()
    if (!question) return
    onAskFollowup(question)
    setFollowup(null)
  }

  /** 粘贴 / 选择图片：先压缩登记成 asset（objectURL 仅作预览），提交时才落库 */
  const attachImages = async (files: File[]) => {
    if (files.length === 0) return
    try {
      const created = await Promise.all(
        files.map(async (file) => {
          const asset = await createImageAsset(file, projectId)
          return { asset, url: URL.createObjectURL(asset.blob) }
        }),
      )
      setPendingImages((previous) => [...previous, ...created])
    } catch (error) {
      toast.error(`图片读取失败：${errorMessage(error)}`)
    }
  }

  const removePendingImage = (assetId: Id) => {
    setPendingImages((previous) => {
      const target = previous.find((item) => item.asset.id === assetId)
      if (target) URL.revokeObjectURL(target.url)
      return previous.filter((item) => item.asset.id !== assetId)
    })
  }

  /** 提交回答：图片资产先落库再随消息带 id 上行（纯图片作答也合法） */
  const submitAnswer = async () => {
    if (isEvaluating) return
    if (!draft.trim() && pendingImages.length === 0) return
    const imageIds: Id[] = []
    try {
      for (const pending of pendingImages) {
        await getRepositories().assets.create(pending.asset)
        imageIds.push(pending.asset.id)
      }
    } catch (error) {
      toast.error(`图片保存失败：${errorMessage(error)}`)
      return
    }
    for (const pending of pendingImages) URL.revokeObjectURL(pending.url)
    setPendingImages([])
    onSubmitAnswer(draft, imageIds)
  }

  // ref 只在 effect 里同步（render 期间读写 ref 是 lint 禁区）；换主题 / 卸载时
  // 由下面的 cleanup 回收可能漏掉的预览 URL —— 与上面的 render 校准互为双保险
  useEffect(() => {
    pendingImagesRef.current = pendingImages
  })
  useEffect(
    () => () => {
      for (const pending of pendingImagesRef.current) URL.revokeObjectURL(pending.url)
    },
    [item.itemId],
  )

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

  // 题目卡上的标注（questionMessage 可能为 null，钩子必须无条件调用）
  const questionNotes = useReviewMessageNotes(questionMessage?.id ?? '')

  // 可追问的稳定态：反馈已出（评分前）或补学讲解已展示 —— 此时追问不会打断任何在途请求
  const isFollowupAllowedPhase = isFeedback || isRelearning

  // 追问输入打开即聚焦
  useEffect(() => {
    if (followup) followupRef.current?.focus()
  }, [followup])

  // 划选菜单的动作随阶段裁剪：作答阶段引用进回答框；反馈/补学阶段可追问；
  // 流式与落库中的阶段只留标注与复制 —— 打标签永远可用，但不打断正在进行的请求
  const menuActions: SelectionAction[] =
    isAnswering && !isRelearnAwaitingQuestion
      ? ['annotate', 'quote', 'copy']
      : isFollowupAllowedPhase && !streamingText
        ? ['annotate', 'ask', 'copy']
        : ['annotate', 'copy']

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
            <ReviewAnnotatableText
              messageId={questionMessage.id}
              source={stripReviewRating(questionMessage.text)}
            />
            <MessageNotes notes={questionNotes} className="mt-2" />
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

      {/* 补充对话记录（提示、用户回答、追问、反馈） */}
      {otherMessages.length > 0 && (
        <div className="mt-5 space-y-4">
          {otherMessages.map((msg) => (
            <ReviewTranscriptCard key={msg.id} message={msg} />
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

          {/* 待提交图片预览：与聊天输入框同款胶囊 */}
          <div className="mb-2 flex flex-wrap gap-2 empty:hidden">
            {pendingImages.map((pending) => (
              <div key={pending.asset.id} className="group/img relative">
                <img
                  src={pending.url}
                  alt={pending.asset.name ?? '待发送图片'}
                  className="h-16 w-16 rounded-md border border-line object-cover"
                />
                <button
                  type="button"
                  aria-label="移除这张图片"
                  onClick={() => removePendingImage(pending.asset.id)}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-canvas p-0.5 text-muted transition-colors hover:text-ink"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          <Textarea
            id="review-answer-input"
            ref={textareaRef}
            rows={4}
            value={draft}
            disabled={isEvaluating}
            onChange={(e) => handleDraftChange(e.target.value)}
            onPaste={(e) => {
              const files = imagesFromClipboard(e.nativeEvent)
              if (files.length > 0) {
                e.preventDefault()
                void attachImages(files)
              }
            }}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false
            }}
            onKeyDown={handleKeyDown}
            placeholder="用自己的话简述答案，可粘贴/上传图片（如手写过程）… (Ctrl+Enter 发送)"
            className="w-full text-xs leading-relaxed"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void attachImages(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                disabled={isEvaluating}
                onClick={() => fileInputRef.current?.click()}
                title="上传图片作答"
                className="text-2xs text-muted hover:text-ink disabled:opacity-50"
              >
                <ImagePlus className="mr-1 h-3.5 w-3.5" />
                插入图片
              </Button>
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
              disabled={(!draft.trim() && pendingImages.length === 0) || isEvaluating}
              onClick={() => void submitAnswer()}
            >
              提交回答
            </Button>
          </div>
        </div>
      )}

      {/* 追问输入区：划选「就这段追问」拉起；只在可追问的稳定态存在 */}
      {followup && isFollowupAllowedPhase && (
        <div className="mt-5 rounded-xl border border-line/70 bg-surface p-4 shadow-sm">
          <label htmlFor="review-followup-input" className="block mb-2 text-xs font-medium text-ink">
            就标记的内容追问
          </label>
          {followup.quote ? (
            <blockquote className="mb-2 max-h-24 overflow-y-auto rounded-md border-l-2 border-accent/40 bg-canvas/40 px-2.5 py-1.5 text-xs text-muted">
              <MarkdownView content={followup.quote} />
            </blockquote>
          ) : null}
          <Textarea
            id="review-followup-input"
            ref={followupRef}
            rows={3}
            value={followup.text}
            onChange={(e) => setFollowup({ ...followup, text: e.target.value })}
            onCompositionStart={() => {
              followupComposingRef.current = true
            }}
            onCompositionEnd={() => {
              followupComposingRef.current = false
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !followupComposingRef.current) {
                e.preventDefault()
                submitFollowup()
              }
            }}
            placeholder="这段哪里没讲清楚，或者想让它再考考你… (Ctrl+Enter 发送)"
            className="w-full text-xs leading-relaxed"
          />
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setFollowup(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!followup.text.trim()}
              onClick={submitFollowup}
            >
              提交追问
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

      {/* 划选菜单：动作随阶段裁剪（见 menuActions）；origin=review 决定标注的投喂口径 */}
      <SelectionMenu
        key={item.nodeId}
        nodeId={item.nodeId}
        actions={menuActions}
        noteOrigin="review"
        onQuote={quoteToDraft}
        onAsk={(quote) => setFollowup({ quote, text: '' })}
      />
    </div>
  )
}

/**
 * 历史轮次消息卡（提示 / 回答 / 追问 / 点评补学）。
 *
 * 独立成组件是为了让「这条消息的标注」能以 Hook 取用 —— 标注桶在 store 里按
 * messageId 分组，组件化之后每张卡自己订阅自己的桶，互不牵连重渲染。
 */
function ReviewTranscriptCard({ message }: { message: ReviewSessionMessage }) {
  const notes = useReviewMessageNotes(message.id)
  const imageUrls = useAssetUrls((message.imageIds ?? []).join(','))
  const isUser = message.role === 'user'

  return (
    <div
      className={`rounded-lg border p-4 text-xs leading-relaxed ${
        isUser
          ? 'border-accent/30 bg-accent-soft/20 text-ink ml-8'
          : 'border-line/60 bg-surface text-ink-soft mr-8'
      }`}
    >
      <div className="mb-1 text-2xs text-faint">
        {isUser
          ? userMessageLabel(message.purpose)
          : (OTHER_MESSAGE_LABEL[message.purpose] ?? '反馈')}
      </div>
      {message.text ? (
        <ReviewAnnotatableText messageId={message.id} source={stripReviewRating(message.text)} />
      ) : null}
      {(message.imageIds?.length ?? 0) > 0 ? (
        <div className={message.text ? 'mt-2 flex flex-wrap gap-2' : 'flex flex-wrap gap-2'}>
          {(message.imageIds ?? []).map((id) => {
            const url = imageUrls[id]
            return url ? (
              <img
                key={id}
                src={url}
                alt="作答图片"
                className="max-h-48 rounded-md border border-line/60"
              />
            ) : null
          })}
        </div>
      ) : null}
      <MessageNotes notes={notes} className="mt-2" />
    </div>
  )
}