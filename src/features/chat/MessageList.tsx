import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Pencil,
  RotateCcw,
  Waypoints,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip } from '@/components/ui/tooltip'
import { ENTER_FAST, ENTER_SOFT } from '@/lib/motion'
import {
  messageBodyText,
  messageImageIds,
  messagePreview,
  messageQuotes,
  messageSource,
  messageText,
  messageToolParts,
  replaceMessageText,
  userBodySpans,
} from '@/domain/messages'
import type { Id, Message, MessagePart } from '@/domain/models'
import type { NodeActionKind } from '@/domain/node-ops/actions'
import { clampAgentMaxSteps } from '@/domain/defaults'
import { MAX_THREAD_VERSIONS } from '@/domain/thread/mutations'
import { stripReviewRating, stripStreamingReviewRating } from '@/domain/review/protocol'
import { resolveThread, summarizeSlotVersions } from '@/domain/thread/resolve'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { formatClock } from '@/lib/time'
import { cn, humanizeStreamError } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { isStreamingIn, useWorkspaceStore } from '@/stores/workspace-store'
import { MessageNotes } from './MessageNotes'
import { ToolActivities, type ToolActivityItem } from './ToolActivities'
import {
  bodyProps,
  sourceSpanProps,
} from './note-anchor'
import { useAssetUrls } from './useAssetUrls'
import { useNoteHighlights } from './useNoteHighlights'
import { useThrottledValue } from './useThrottledValue'

const PRUNE_NOTICE = '最多保留 3 个版本，最早的版本已删除'

/**
 * 新消息进场：只给「这一轮新落库的气泡」播一次浮现（是否播由 on 决定，
 * 判定逻辑在 MessageList 里）。切节点、首屏加载一律不播 —— 动画只解释
 * 「刚发生的事」，不重演历史。
 */
function Entrance({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <motion.div
      initial={on ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={ENTER_SOFT}
    >
      {children}
    </motion.div>
  )
}

/** 稳定引用：直接写 `?? []` 会让依赖数组每次渲染都变，memo 白做 */
const NO_MESSAGES: Message[] = []

/** 版本横线要的全部信息：当前第几版、共几版，以及每一版的首条消息摘要。 */
interface VersionDividerInfo {
  slotId: Id
  index: number
  total: number
  variants: Array<{ version: number; preview: string | null }>
}

/** 气泡下方那排小操作：用户消息与 AI 消息共用同一套样式，只有文案不同。 */
const MessageAction = memo(function MessageAction({
  icon: Icon,
  label,
  disabled,
  onClick,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-muted transition-colors hover:bg-elevated hover:text-ink disabled:pointer-events-none disabled:opacity-45"
      >
        <Icon className="h-3 w-3" />
        {children}
      </button>
    </Tooltip>
  )
})

const MessageImages = memo(function MessageImages({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {urls.map((url) => (
        <img
          key={url.slice(-40)}
          src={url}
          alt="粘贴的图片"
          className="max-h-56 rounded-lg border border-line object-contain"
        />
      ))}
    </div>
  )
})

/**
 * 版本横线：画在当前版本第一条消息下方，居中 `< 2/3 >`。
 * 只有 total > 1 时才会渲染；hover 显示该版首条消息的摘要，切换后由列表把横线滚进视野。
 */
const VersionDivider = memo(function VersionDivider({
  ref,
  info,
  disabled,
  onSelect,
}: {
  ref?: Ref<HTMLDivElement>
  info: VersionDividerInfo
  disabled: boolean
  onSelect: (version: number) => void
}) {
  const current = info.variants[info.index]
  const previous = info.index > 0 ? info.variants[info.index - 1] : null
  const next = info.index < info.total - 1 ? info.variants[info.index + 1] : null
  const arrowClass =
    'grid h-5 w-5 place-items-center rounded-sm text-faint transition-colors hover:bg-elevated hover:text-ink disabled:pointer-events-none disabled:opacity-40'

  return (
    <div
      ref={ref}
      // 紧贴上一版的第一条气泡：列表的 space-y-4 用负边距抵消一半
      className="-mt-2 flex items-center gap-2 px-1 py-0.5"
      data-version-divider={info.slotId}
    >
      <span className="h-px flex-1 bg-line/50" />
      <Tooltip
        label={previous ? `上一版：${previous.preview ?? '（空版本）'}` : '没有更早的版本了'}
      >
        <button
          type="button"
          aria-label="上一版"
          disabled={disabled || !previous}
          onClick={() => previous && onSelect(previous.version)}
          className={arrowClass}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <Tooltip label={`第 ${info.index + 1}/${info.total} 版 · ${current?.preview ?? '（空版本）'}`}>
        <span className="min-w-[34px] text-center text-2xs tabular-nums text-muted">
          {info.index + 1}/{info.total}
        </span>
      </Tooltip>
      <Tooltip label={next ? `下一版：${next.preview ?? '（空版本）'}` : '已经是最新版了'}>
        <button
          type="button"
          aria-label="下一版"
          disabled={disabled || !next}
          onClick={() => next && onSelect(next.version)}
          className={arrowClass}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
      <span className="h-px flex-1 bg-line/50" />
    </div>
  )
})

/**
 * 编辑态：正文换成自动高度的 textarea，引用与图片以只读小卡保留（图片复用 assetId，不重传）。
 * Esc 取消；Ctrl/Cmd+Enter 或「发送」提交；内容没变化或为空时发送禁用。
 */
const MessageEditor = memo(function MessageEditor({
  message,
  assetUrls,
  disabled,
  onCancel,
  onSubmit,
}: {
  message: Message
  assetUrls: string[]
  disabled: boolean
  onCancel: () => void
  onSubmit: (parts: MessagePart[]) => void
}) {
  const [text, setText] = useState(() => messageBodyText(message))
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const quotes = messageQuotes(message)
  const original = messageBodyText(message)

  const resize = () => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
    resize()
  }, [])

  const trimmed = text.trim()
  const canSend = !disabled && trimmed.length > 0 && trimmed !== original

  return (
    <div className="flex w-full max-w-[86%] flex-col gap-2 rounded-xl rounded-br-sm border border-accent/45 bg-elevated px-3 py-2.5">
      {quotes.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {quotes.map((quote, index) => (
            <blockquote
              key={index}
              className="whitespace-pre-wrap rounded-md border-l-2 border-accent/40 bg-canvas/40 px-2.5 py-1.5 text-xs leading-relaxed text-muted"
            >
              {quote}
            </blockquote>
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        onChange={(event) => {
          setText(event.target.value)
          resize()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (
            event.key === 'Enter' &&
            (event.ctrlKey || event.metaKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            if (canSend) onSubmit(replaceMessageText(message, trimmed))
          }
        }}
        className="max-h-[180px] w-full resize-none bg-transparent text-base leading-relaxed text-ink outline-none"
      />

      {assetUrls.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {assetUrls.map((url) => (
            <img
              key={url.slice(-40)}
              src={url}
              alt="消息里原有的图片"
              className="h-14 w-14 rounded-md border border-line object-cover"
            />
          ))}
          <span className="text-2xs text-faint">图片原样保留</span>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-faint">
          {trimmed.length === 0
            ? '内容不能为空'
            : trimmed === original
              ? '内容没有改动'
              : 'Ctrl/⌘+Enter 发送 · Esc 取消'}
        </span>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSend}
            onClick={() => onSubmit(replaceMessageText(message, trimmed))}
          >
            发送
          </Button>
        </div>
      </div>
    </div>
  )
})

const MessageBubble = memo(function MessageBubble({
  message,
  assetUrls,
  onAction,
  isLast,
  canRegenerate,
  onRegenerate,
  busy,
  editing,
  canEdit,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: Message
  assetUrls: string[]
  onAction: (kind: NodeActionKind, messageId: Id) => void
  isLast: boolean
  canRegenerate: boolean
  onRegenerate: () => void
  /** 这一轮正在生成：编辑入口与版本切换都要禁用 */
  busy: boolean
  editing: boolean
  canEdit: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSubmitEdit: (parts: MessagePart[]) => void
}) {
  const isUser = message.role === 'user'
  const text = messageText(message)
  const quotes = messageQuotes(message)
  const body = messageBodyText(message)
  const notes = useWorkspaceStore((state) => state.notesByMessage[message.id]) ?? []
  // 标注坐标系的源文（见 domain/messages.messageSource）：渲染与锚点共用这一串
  const source = messageSource(message)
  const userSpans = useMemo(
    () => (isUser ? userBodySpans(message) : null),
    [isUser, message],
  )
  // 落库的工具记录：渲染成工具卡（在正文容器之外），让「查过什么」在刷新后仍然可见
  const toolItems: ToolActivityItem[] = messageToolParts(message).map((part) => ({
    callId: part.callId,
    name: part.name,
    input: part.input,
    status: part.error ? 'error' : 'done',
    ...(part.output !== undefined ? { output: part.output } : {}),
    ...(part.error !== undefined ? { error: part.error } : {}),
  }))

  // 正文容器的 ref 同时是笔记锚点的基准：`data-message-body` 标出「正文是哪一段文本」，
  // 框选时按它数下标，渲染笔记时按它还原区间（见 note-anchor.ts）。
  // 源文也由这个钩子登记：框选、高亮与写工具都要它把选区换回原文坐标
  const bodyRef = useRef<HTMLDivElement>(null)
  useNoteHighlights(bodyRef, message.id, notes, source)

  const cleanText = stripReviewRating(text).trim()
  const hasContent = isUser
    ? quotes.length > 0 || Boolean(body?.trim()) || assetUrls.length > 0
    : Boolean(cleanText) || assetUrls.length > 0

  if (editing && isUser) {
    return (
      <div data-message-id={message.id} className="flex flex-col items-end gap-1">
        <MessageEditor
          message={message}
          assetUrls={assetUrls}
          disabled={busy}
          onCancel={onCancelEdit}
          onSubmit={onSubmitEdit}
        />
      </div>
    )
  }

  return (
    <div
      data-message-id={message.id}
      className={cn('group/message flex flex-col gap-1', isUser ? 'items-end' : 'items-stretch')}
    >
      {/* 工具卡画在正文气泡之前：与流式阶段一致（先查后答），且在 data-message-body 之外避免标注错位 */}
      {!isUser && toolItems.length > 0 ? (
        <ToolActivities tools={toolItems} className="flex flex-col gap-1" />
      ) : null}

      {hasContent ? (
        <div
          onDoubleClick={
            isUser && canEdit
              ? () => {
                  // 双击本来会选中一个词，顺手清掉选区，免得框选菜单跟着弹出来
                  window.getSelection()?.removeAllRanges()
                  onStartEdit()
                }
              : undefined
          }
          className={cn(
            'max-w-full',
            isUser
              ? 'max-w-[86%] rounded-xl rounded-br-sm border border-line/50 bg-elevated px-3.5 py-2.5'
              : 'rounded-xl rounded-bl-sm border border-line/40 bg-surface/70 px-3.5 py-3',
          )}
        >
          {isUser ? (
            <div ref={bodyRef} {...bodyProps(message.id)} className="flex flex-col gap-2">
              {quotes.map((quote, index) => (
                <blockquote
                  key={index}
                  {...(userSpans?.quotes[index]
                    ? sourceSpanProps(userSpans.quotes[index])
                    : {})}
                  className="whitespace-pre-wrap rounded-md border-l-2 border-accent/40 bg-canvas/40 px-2.5 py-1.5 text-xs leading-relaxed text-muted"
                >
                  {quote}
                </blockquote>
              ))}
              {body ? (
                <p
                  {...(userSpans?.body ? sourceSpanProps(userSpans.body, userSpans.bodyExact) : {})}
                  className="whitespace-pre-wrap text-base leading-relaxed text-ink"
                >
                  {body}
                </p>
              ) : null}
            </div>
          ) : (
            <div ref={bodyRef} {...bodyProps(message.id)}>
              {/* 复习评分标记是给客户端与模型看的协议，不进正文 */}
              <MarkdownView content={source} />
            </div>
          )}
          <MessageImages urls={assetUrls} />
        </div>
      ) : null}

      <MessageNotes notes={notes} align={isUser ? 'end' : 'start'} />

      {message.meta?.error ? (
        <div className="flex flex-col gap-1 px-1 text-2xs text-danger">
          <div className="flex flex-wrap items-center gap-2">
            <span>生成中断：{message.meta.error}</span>
            {isLast ? (
              <button
                type="button"
                onClick={onRegenerate}
                className="rounded-sm border border-danger/40 px-1.5 py-0.5 transition-colors hover:bg-danger-soft"
              >
                重新生成
              </button>
            ) : null}
          </div>
          {message.meta.errorHint ? (
            <p className="text-2xs leading-relaxed text-muted">{message.meta.errorHint}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 px-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100">
        <span className="text-2xs text-faint">{formatClock(message.createdAt)}</span>
        {isUser ? (
          <MessageAction
            icon={Pencil}
            label={canEdit ? '编辑这条提问，从它开始整段换一版' : '正在生成，这一轮结束后才能编辑'}
            disabled={!canEdit}
            onClick={onStartEdit}
          >
            编辑
          </MessageAction>
        ) : null}
        {/* 两种角色都能 fork：用户消息 = 从这次提问重开，AI 消息 = 从这条回答接着往下走 */}
        <MessageAction
          icon={GitBranch}
          label={
            isUser
              ? '以这条提问为起点，在下方新建继承上下文的节点'
              : '以这条回答为起点，在下方新建继承上下文的节点'
          }
          onClick={() => onAction('branch', message.id)}
        >
          分支
        </MessageAction>
        <MessageAction
          icon={Waypoints}
          label={
            isUser
              ? '以这条提问为起点，横向新建继承上下文的节点'
              : '以这条回答为起点，横向新建继承上下文的节点'
          }
          onClick={() => onAction('diverge', message.id)}
        >
          发散
        </MessageAction>
        {!isUser && isLast ? (
          <MessageAction
            icon={RotateCcw}
            label={canRegenerate ? '重新生成这条回答' : '正在生成，这一轮结束后才能重新生成'}
            disabled={!canRegenerate}
            onClick={onRegenerate}
          >
            重新生成
          </MessageAction>
        ) : null}
      </div>
    </div>
  )
})

/** 重新生成 + 统一的「淘汰最早版本」提示；错误气泡与消息操作都走它。 */
function useRegenerateAction(nodeId: Id): (messageId?: Id) => Promise<void> {
  const regenerate = useWorkspaceStore((state) => state.regenerate)
  return useCallback(
    async (messageId?: Id) => {
      const result = await regenerate(nodeId, messageId)
      if (result?.pruned) toast.info(PRUNE_NOTICE)
    },
    [nodeId, regenerate],
  )
}

function StreamingBubble({ nodeId, onRetry }: { nodeId: Id; onRetry: () => void }) {
  const streaming = useWorkspaceStore((state) => state.streaming)
  const maxSteps = useSettingsStore((state) => clampAgentMaxSteps(state.settings.agentMaxSteps))
  const text = useThrottledValue(streaming?.text ?? '', 70)

  // 这一轮属于别的节点时不在这里渲染，否则切到别的节点还能看见它的「正在思考」
  if (!streaming || streaming.nodeId !== nodeId) return null

  // 失败得连一个字都没吐出来时不会有消息落库，错误只能挂在这一轮上：直接给个重来的入口
  if (streaming.error) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={ENTER_FAST}
        className="flex flex-wrap items-center gap-2 rounded-xl rounded-bl-sm border border-danger/30 bg-danger-soft/40 px-3.5 py-2.5 text-2xs text-danger"
      >
        <span>生成中断：{humanizeStreamError(streaming.error)}</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-sm border border-danger/40 px-1.5 py-0.5 transition-colors hover:bg-danger-soft"
        >
          重新生成
        </button>
      </motion.div>
    )
  }

  const tools = streaming.tools ?? []
  const running = tools.some((tool) => tool.status === 'running')

  return (
    <motion.div
      // AnimatePresence 的退场就是「流式→落库」的交棒：思考气泡淡出，
      // 同一帧里正式回答以新消息身份浮现（见 MessageList 的 Entrance）。
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={ENTER_SOFT}
      className="flex flex-col gap-1"
    >
      {tools.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 px-0.5 text-2xs text-faint">
            <span>
              {maxSteps > 0
                ? `第 ${Math.min(tools.length + (running ? 0 : 1), maxSteps)} / ${maxSteps} 步`
                : `第 ${tools.length + (running ? 0 : 1)} 步`}
            </span>
            <span>·</span>
            <span>本轮查了 {tools.length} 次项目数据</span>
          </div>
          <ToolActivities tools={tools} animateIn />
        </div>
      ) : null}

      <div className="rounded-xl rounded-bl-sm border border-accent/20 bg-surface/70 px-3.5 py-3">
        {text ? (
          // 流式期间也把（可能写到一半的）评分标记收掉
          <MarkdownView content={stripStreamingReviewRating(text)} />
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:300ms]" />
            </span>
            {running ? '正在查项目数据…' : '正在思考…'}
          </div>
        )}
        {text ? (
          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-accent" />
        ) : null}
      </div>
    </motion.div>
  )
}

export function MessageList({ nodeId }: { nodeId: Id }) {
  const node = useWorkspaceStore((state) => state.nodes.find((item) => item.id === nodeId))
  const messages = useWorkspaceStore((state) => state.messagesByNode[nodeId]) ?? NO_MESSAGES
  const applyAction = useWorkspaceStore((state) => state.applyAction)
  const editUserMessage = useWorkspaceStore((state) => state.editUserMessage)
  const setSlotVersion = useWorkspaceStore((state) => state.setSlotVersion)
  const streamingHere = useWorkspaceStore((state) => isStreamingIn(state.streaming, nodeId))
  // 含错误态的「本轮仍在场」：错误框也要在 AnimatePresence 里待到被关掉为止
  const streamingRoundHere = useWorkspaceStore(
    (state) => state.streaming?.nodeId === nodeId,
  )
  const streamingMessageId = useWorkspaceStore((state) =>
    state.streaming?.nodeId === nodeId ? state.streaming.messageId : null,
  )
  const regenerate = useRegenerateAction(nodeId)
  const peekVersionPrune = useWorkspaceStore((state) => state.peekVersionPrune)
  const notesByMessage = useWorkspaceStore((state) => state.notesByMessage)

  // 节点内只有一个编辑态；带着节点 id 记，切节点后自然失效（不用 effect 重置）
  const [editing, setEditing] = useState<{ nodeId: Id; messageId: Id } | null>(null)
  const editingId = editing?.nodeId === nodeId ? editing.messageId : null

  // 版本淘汰确认：重新生成/编辑重发要挤掉最早一版时，先问一句再动手
  const [pruneConfirm, setPruneConfirm] = useState<{
    kind: 'regenerate' | 'edit'
    messageId?: Id
    parts?: MessagePart[]
    removedCount: number
    notesCount: number
  } | null>(null)

  // 上滚之后给一枚「回到底部」，长对话不再丢位置感
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)

  const viewportRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const dividerRefs = useRef(new Map<Id, HTMLDivElement>())
  const pendingScrollSlot = useRef<Id | null>(null)

  const resolved = useMemo(
    () => (node ? resolveThread(node, messages) : { path: [], versions: new Map() }),
    [node, messages],
  )
  const visible = resolved.path

  const versions = useMemo(() => {
    const map = new Map<Id, VersionDividerInfo>()
    if (!node) return map
    const byId = new Map(messages.map((message) => [message.id, message]))
    for (const [messageId, info] of resolved.versions) {
      map.set(messageId, {
        slotId: info.slotId,
        index: info.index,
        total: info.total,
        variants: summarizeSlotVersions(node, messages, info.slotId).map((summary) => {
          const first = summary.messageId ? byId.get(summary.messageId) : undefined
          return {
            version: summary.version,
            preview: first ? messagePreview(first, 48) : null,
          }
        }),
      })
    }
    return map
  }, [node, messages, resolved.versions])

  const idsKey = visible.flatMap((message) => messageImageIds(message)).join(',')
  const assetUrls = useAssetUrls(idsKey)
  const lastIndex = visible.length - 1

  // 哪些气泡播进场动画：官方「渲染期调整 state」模式 —— state 记着上一次渲染的在场名单，
  // 与本次 visible 的差集就是「刚到场」的气泡。全程纯派生（读 state、条件式 setState），
  // StrictMode 双渲染结果一致，也不碰 effect。
  const [seenState, setSeenState] = useState<{ nodeId: Id; ids: Set<Id>; fresh: Set<Id> }>(() => ({
    nodeId,
    ids: new Set(visible.map((message) => message.id)),
    fresh: new Set<Id>(),
  }))

  let freshIds: Set<Id>
  if (seenState.nodeId !== nodeId) {
    // 刚切到这个节点：整列都是历史，一律不播 —— 动画只解释「刚发生的事」
    freshIds = new Set()
    setSeenState({
      nodeId,
      ids: new Set(visible.map((message) => message.id)),
      fresh: freshIds,
    })
  } else if (
    seenState.ids.size !== visible.length ||
    !visible.every((message) => seenState.ids.has(message.id))
  ) {
    // 有消息进出：本次的差集就是「刚落库」的那批
    freshIds = new Set(
      visible.map((message) => message.id).filter((id) => !seenState.ids.has(id)),
    )
    setSeenState({ nodeId, ids: new Set(visible.map((message) => message.id)), fresh: freshIds })
  } else {
    // 名单没变：沿用上一次记录的差集（initial 只在挂载时生效，翻面无副作用）
    freshIds = seenState.fresh
  }

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !stickToBottom.current) return
    viewport.scrollTop = viewport.scrollHeight
  }, [visible.length, nodeId, streamingMessageId])

  // 切节点时重置「回到底部」：渲染期调整 state（官方推荐模式），避开 effect 内 setState
  const [jumpNodeId, setJumpNodeId] = useState(nodeId)
  if (jumpNodeId !== nodeId) {
    setJumpNodeId(nodeId)
    setShowJumpToBottom(false)
  }

  useEffect(() => {
    stickToBottom.current = true
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [nodeId])

  // 切完版本把横线带回视野：切换后横线会落到另一条气泡下面
  useEffect(() => {
    const slotId = pendingScrollSlot.current
    if (!slotId) return
    pendingScrollSlot.current = null
    dividerRefs.current.get(slotId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [resolved])

  const switchVersion = useCallback(
    (slotId: Id, version: number) => {
      pendingScrollSlot.current = slotId
      void setSlotVersion(nodeId, slotId, version)
    },
    [nodeId, setSlotVersion],
  )

  const doSubmitEdit = useCallback(
    async (messageId: Id, parts: MessagePart[]) => {
      setEditing(null)
      const result = await editUserMessage(nodeId, messageId, parts)
      if (result?.pruned) toast.info(PRUNE_NOTICE)
    },
    [editUserMessage, nodeId],
  )

  /** 把淘汰名单翻译成确认框需要的计数：连带的标注笔记也要说清楚。 */
  const openPruneConfirm = useCallback(
    (kind: 'regenerate' | 'edit', messageId: Id | undefined, parts?: MessagePart[]) => {
      const preview = peekVersionPrune(nodeId, kind, messageId)
      if (!preview) return false
      const removedSet = new Set(preview.removedMessageIds)
      const notesCount = Object.values(notesByMessage).reduce(
        (sum, bucket) => sum + bucket.filter((note) => removedSet.has(note.messageId)).length,
        0,
      )
      setPruneConfirm({ kind, messageId, parts, removedCount: preview.removedMessageIds.length, notesCount })
      return true
    },
    [nodeId, peekVersionPrune, notesByMessage],
  )

  const submitEdit = useCallback(
    (messageId: Id, parts: MessagePart[]) => {
      // 先预演：不淘汰就直接提交；要淘汰就先确认，编辑草稿保留在原地
      if (openPruneConfirm('edit', messageId, parts)) return
      void doSubmitEdit(messageId, parts)
    },
    [doSubmitEdit, openPruneConfirm],
  )

  const requestRegenerate = useCallback(
    (messageId?: Id) => {
      if (openPruneConfirm('regenerate', messageId)) return
      void regenerate(messageId)
    },
    [openPruneConfirm, regenerate],
  )

  const confirmPrune = useCallback(() => {
    if (!pruneConfirm) return
    const { kind, messageId, parts } = pruneConfirm
    setPruneConfirm(null)
    if (kind === 'regenerate') {
      void regenerate(messageId)
    } else if (messageId && parts) {
      void doSubmitEdit(messageId, parts)
    }
  }, [pruneConfirm, regenerate, doSubmitEdit])

  return (
    <div className="relative min-h-0 flex-1">
    <div
      ref={viewportRef}
      onScroll={(event) => {
        const element = event.currentTarget
        stickToBottom.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 96
        setShowJumpToBottom(
          element.scrollHeight - element.scrollTop - element.clientHeight > 400,
        )
      }}
      className="h-full space-y-4 overflow-y-auto px-4 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {visible.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
          <p className="text-sm text-muted">还没有对话</p>
          <p className="max-w-[220px] text-xs leading-relaxed text-faint">
            对话就是节点的内容，标题与摘要都由它生成。
          </p>
        </div>
      ) : null}

      {visible.map((message, index) => {
        const version = versions.get(message.id)
        const fresh = freshIds.has(message.id)
        return (
          <Fragment key={message.id}>
            <Entrance on={fresh}>
              <MessageBubble
                message={message}
                assetUrls={messageImageIds(message)
                  .map((id) => assetUrls[id])
                  .filter((url): url is string => Boolean(url))}
                onAction={(kind, messageId) => void applyAction(kind, nodeId, messageId)}
                isLast={index === lastIndex}
                canRegenerate={index === lastIndex && !streamingHere}
                onRegenerate={() => requestRegenerate(message.id)}
                busy={streamingHere}
                editing={editingId === message.id}
                canEdit={message.role === 'user' && !streamingHere}
                onStartEdit={() => setEditing({ nodeId, messageId: message.id })}
                onCancelEdit={() => setEditing(null)}
                onSubmitEdit={(parts) => void submitEdit(message.id, parts)}
              />
            </Entrance>
            {version && version.total > 1 ? (
              <VersionDivider
                ref={(element) => {
                  if (element) dividerRefs.current.set(version.slotId, element)
                  else dividerRefs.current.delete(version.slotId)
                }}
                info={version}
                disabled={streamingHere}
                onSelect={(next) => switchVersion(version.slotId, next)}
              />
            ) : null}
          </Fragment>
        )
      })}

      <AnimatePresence initial={false}>
        {streamingRoundHere ? (
          <StreamingBubble key={`streaming-${nodeId}`} nodeId={nodeId} onRetry={() => requestRegenerate()} />
        ) : null}
      </AnimatePresence>
    </div>

    {/* 定位居中的壳负责绝对定位，按钮本体只管进出场 —— 两种 transform 各走各的属性，互不覆盖 */}
    <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2">
      <AnimatePresence initial={false}>
        {showJumpToBottom ? (
          <motion.button
            key="jump-to-bottom"
            type="button"
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={ENTER_FAST}
            onClick={() => {
              stickToBottom.current = true
              const viewport = viewportRef.current
              if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
              setShowJumpToBottom(false)
            }}
            className="pointer-events-auto flex items-center gap-1 rounded-full border border-line bg-elevated/95 px-2.5 py-1 text-2xs text-ink-soft shadow-panel backdrop-blur transition-colors hover:text-ink"
          >
            <ChevronDown className="h-3 w-3" />
            回到底部
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>

    {/* 版本淘汰确认：淘汰是静默删数据，先说清楚会丢什么再动手 */}
    <Dialog open={Boolean(pruneConfirm)} onOpenChange={(open) => !open && setPruneConfirm(null)}>
      <DialogContent className="w-[min(400px,100%)]">
        <DialogHeader>
          <DialogTitle>
            {pruneConfirm?.kind === 'edit' ? '提交编辑将淘汰最早的版本' : '重新生成将淘汰最早的版本'}
          </DialogTitle>
          <DialogDescription>
            最多保留 {MAX_THREAD_VERSIONS} 个版本。最早的一版（{pruneConfirm?.removedCount ?? 0} 条消息
            {pruneConfirm && pruneConfirm.notesCount > 0
              ? `、其中标注笔记 ${pruneConfirm.notesCount} 条`
              : ''}
            ）会被删除，无法恢复。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setPruneConfirm(null)}>
            取消
          </Button>
          <Button variant="danger" onClick={confirmPrune}>
            {pruneConfirm?.kind === 'edit' ? '仍然提交' : '仍然重新生成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </div>
  )
}