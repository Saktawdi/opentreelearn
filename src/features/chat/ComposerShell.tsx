import { ChevronDown, ImagePlus, Loader2, MessageSquareQuote, SendHorizontal, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import type { Id } from '@/domain/models'
import { ENTER_FAST } from '@/lib/motion'
import { normalizeWhitespace } from '@/lib/text'
import { useIsMobile } from '@/lib/use-is-mobile'
import { cn } from '@/lib/utils'
import { imagesFromDataTransfer } from '@/services/images'
import type { PendingImage } from './useComposerDraft'

/** 待发图片的形状由草稿钩子定义，这里转出去，调用方不必绕到实现文件里取类型。 */
export type { PendingImage }

/** 输入框本体对外提供的能力：把焦点还给输入区（引用胶囊落位后要用）。 */
export interface ComposerShellHandle {
  /** `preventScroll` 对复习练习很关键：聚焦若把输入区滚进视野，会把刚展示的题目拽出视口 */
  focus: (options?: FocusOptions) => void
  expand?: () => void
  collapse?: () => void
}

/**
 * 输入框里与「谁在用」无关的那部分数据。
 *
 * 可选字段就是能力开关：没有 `attachFiles` 就没有图片入口，没有 `quotes` 就没有
 * 引用栏 —— 自由问答不发图片，没必要为了形似摆一个点不动的按钮。
 */
export interface ComposerShellDraft {
  /** 草稿还在读：只渲染骨架，用户此刻打的字会被随后到达的草稿盖掉 */
  loading?: boolean
  text: string
  setText: (value: string) => void
  quotes?: string[]
  removeQuote?: (quote: string) => void
  pending?: PendingImage[]
  removePending?: (assetId: Id) => void
  attachFiles?: (files: File[]) => void | Promise<void>
}

export interface ComposerShellProps {
  draft: ComposerShellDraft
  /** 点发送 / 按 Enter 时调用；正文、引用、图片由调用方自行取用 */
  onSubmit: () => void | Promise<void>
  /** 粘贴拦截：不给时粘贴按浏览器默认行为走（往正文里贴文本） */
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  canSubmit: boolean
  /** 提交后的短等待（例如转存图片）：按钮转圈并挡住连击 */
  busy?: boolean
  streaming: boolean
  /** 生成中可以停下 —— 会话页与自由问答都能中断，复习练习没有中断语义时不传 */
  onStop?: () => void
  /** 发送按钮不可用时补一句说明（例如「另一个节点正在生成」） */
  sendHint?: string
  placeholder: string
  /** 底部工具条左侧：会话页放模型选择，自由问答放 Enter 提示 */
  toolbar?: ReactNode
  /** 输入框 id：外部 <label htmlFor> 指向它（复习练习用） */
  textareaId?: string
  className?: string
  ref?: Ref<ComposerShellHandle>
  /** 移动端折叠沉浸式：窄屏下默认折叠为底部极简胶囊条，点按才向上展开 */
  collapsibleOnMobile?: boolean
}

const EMPTY_QUOTES: string[] = []
const EMPTY_PENDING: PendingImage[] = []

/** 正文最高长到这里（像素），再长就在框内滚动 */
const MAX_HEIGHT = 180

/**
 * 输入框本体：会话页与复习中心「自由问答」共用同一只框。
 *
 * 边界划在这里 —— 组件只管**框**：自适应高度的正文、引用胶囊、待发图片、
 * Enter 发送与发送/停止按钮；内容从哪来、发出去做什么，由调用方的 `draft`
 * 与 `onSubmit` 决定。两处输入框长得一样、敲键行为一样，靠的就是这份共用；
 * 草稿存哪则各随各的（会话写 IndexedDB，自由问答随对话留在内存）。
 */
export function ComposerShell({
  ref,
  draft,
  onSubmit,
  onPaste,
  canSubmit,
  busy = false,
  streaming,
  onStop,
  sendHint,
  placeholder,
  toolbar,
  textareaId,
  className,
  collapsibleOnMobile = true,
}: ComposerShellProps) {
  const { t } = useTranslation('chat')
  const isMobile = useIsMobile()
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const quotes = draft.quotes ?? EMPTY_QUOTES
  const pending = draft.pending ?? EMPTY_PENDING
  const canAttach = Boolean(draft.attachFiles)

  useImperativeHandle(
    ref,
    () => ({
      focus: (options) => {
        if (isMobile && collapsibleOnMobile) {
          setMobileExpanded(true)
        }
        window.setTimeout(() => textareaRef.current?.focus(options), 50)
      },
      expand: () => setMobileExpanded(true),
      collapse: () => setMobileExpanded(false),
    }),
    [isMobile, collapsibleOnMobile],
  )

  const handleFormSubmit = async () => {
    await onSubmit()
    if (isMobile && collapsibleOnMobile) {
      setMobileExpanded(false)
    }
  }

  // 正文一变就把高度收拢再撑开：草稿回填和发送后清空都不会留下旧高度
  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [draft.text, draft.loading])

  // 移动端折叠沉浸式：未展开时仅呈现底部极简追问胶囊
  if (isMobile && collapsibleOnMobile && !mobileExpanded) {
    return (
      <div
        className={cn(
          'shrink-0 border-t border-line/60 p-2.5 pb-safe bg-surface/90 backdrop-blur-md transition-colors',
          className,
        )}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            setMobileExpanded(true)
            window.setTimeout(() => textareaRef.current?.focus(), 80)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setMobileExpanded(true)
              window.setTimeout(() => textareaRef.current?.focus(), 80)
            }
          }}
          className="flex h-10 w-full items-center justify-between rounded-full border border-line bg-elevated/80 px-3.5 shadow-panel transition-all active:scale-[0.99] cursor-pointer"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="truncate">
              {draft.text.trim()
                ? draft.text
                : quotes.length > 0
                  ? t('composer.quotedDraft', { count: quotes.length })
                  : placeholder}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            {streaming && onStop ? (
              <Button
                variant="subtle"
                size="icon-sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onStop()
                }}
                className="h-7 w-7 rounded-full text-accent"
              >
                <Square className="h-3 w-3" />
              </Button>
            ) : (
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-surface text-muted">
                <SendHorizontal className="h-3 w-3" />
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      onDragOver={(event) => {
        if (!canAttach) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!canAttach) return
        event.preventDefault()
        setDragging(false)
        // 拖放区在草稿读取期间也一直在：图片进来了也会被随后到达的草稿整个盖掉
        if (draft.loading) return
        void draft.attachFiles?.(imagesFromDataTransfer(event.dataTransfer))
      }}
      className={cn(
        'shrink-0 border-t border-line/60 p-3 pb-safe transition-colors',
        dragging ? 'bg-accent-soft/40' : 'bg-transparent',
        className,
      )}
    >
      {/* 移动端展开模式下的顶部小栏：提示当前在输入，并提供收起按钮 */}
      {isMobile && collapsibleOnMobile ? (
        <div className="flex items-center justify-between pb-2 px-1">
          <span className="flex items-center gap-1.5 text-xs font-medium text-ink-soft">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            {t('composer.promptTitle')}
          </span>
          <button
            type="button"
            onClick={() => setMobileExpanded(false)}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:text-ink active:bg-elevated transition-colors"
          >
            <span>{t('action.collapse')}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* 容器常驻（empty:hidden 兜住空态），最后一枚图片退场时才有地方淡出 */}
      <div className="mb-2 flex flex-wrap gap-2 empty:hidden">
        <AnimatePresence initial={false}>
          {pending.map((item) => (
            <motion.div
              key={item.asset.id}
              initial={{ opacity: 0, scale: 0.88 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.88 }}
              transition={ENTER_FAST}
              className="group/img relative"
            >
              <img
                src={item.url}
                alt={item.asset.name ?? t('composer.pendingImageAlt')}
                className="h-16 w-16 rounded-md border border-line object-cover"
              />
              <button
                type="button"
                onClick={() => draft.removePending?.(item.asset.id)}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-canvas p-0.5 text-muted opacity-0 transition-opacity hover:text-ink group-hover/img:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="rounded-lg border border-line/60 bg-canvas/40 transition-colors focus-within:border-accent/40">
        {/* 容器常驻（empty:hidden 兜住空态），最后一枚引用退场时才有地方淡出 */}
        <div className="flex flex-wrap gap-1.5 px-2 pt-2 empty:hidden">
          <AnimatePresence initial={false}>
            {quotes.map((quote) => (
              <motion.span
                key={quote}
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={ENTER_FAST}
                title={quote}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft/50 py-0.5 pl-2 pr-1 text-2xs text-ink-soft"
              >
                <MessageSquareQuote className="h-3 w-3 shrink-0 text-accent/80" />
                <span className="max-w-[280px] truncate">{normalizeWhitespace(quote)}</span>
                <button
                  type="button"
                  aria-label={t('composer.removeQuoteAria')}
                  onClick={() => draft.removeQuote?.(quote)}
                  className="rounded-full p-0.5 text-muted transition-colors hover:text-ink"
                >
                  <X className="h-3 w-3" />
                </button>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>

        {/* 草稿读取期间不渲染输入框：用户此刻打的字会被随后到达的草稿覆盖 */}
        {draft.loading ? (
          <Skeleton className="mx-3 my-3 h-5 w-2/3" />
        ) : (
          <textarea
            ref={textareaRef}
            id={textareaId}
            value={draft.text}
            rows={1}
            onChange={(event) => draft.setText(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && isMobile && collapsibleOnMobile) {
                event.preventDefault()
                setMobileExpanded(false)
                return
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (canSubmit) void handleFormSubmit()
              }
            }}
            placeholder={placeholder}
            className="max-h-[180px] w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-ink outline-none placeholder:text-faint"
          />
        )}

        <div className="flex items-center justify-between px-2 pb-1.5">
          <div className="flex min-w-0 items-center gap-1">
            {toolbar}

            {canAttach ? (
              <>
                <Tooltip label={t('composer.insertImage')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    // 草稿还在读时先别让图片进来：它会被随后到达的草稿整个覆盖掉
                    disabled={Boolean(draft.loading)}
                    onClick={() => fileInputRef.current?.click()}
                    className="text-muted hover:text-ink"
                  >
                    <ImagePlus className="h-4 w-4" />
                  </Button>
                </Tooltip>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void draft.attachFiles?.(Array.from(event.target.files ?? []))
                    event.target.value = ''
                  }}
                />
              </>
            ) : null}
          </div>

          {streaming && onStop ? (
            <Tooltip label={t('composer.stop')}>
              <Button
                variant="subtle"
                size="icon-sm"
                onClick={onStop}
                aria-label={t('composer.stop')}
                className="rounded-full"
              >
                <Square className="h-3 w-3" />
              </Button>
            </Tooltip>
          ) : (
            <Tooltip label={busy ? t('composer.sending') : (sendHint ?? t('composer.send'))}>
              <Button
                variant="primary"
                size="icon-sm"
                onClick={() => void handleFormSubmit()}
                disabled={!canSubmit}
                aria-label={t('composer.send')}
                className="rounded-full"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SendHorizontal className="h-3.5 w-3.5" />}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}
