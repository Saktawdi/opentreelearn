import { GitBranch, RotateCcw, Waypoints } from 'lucide-react'
import { memo, useEffect, useRef, type ComponentType, type ReactNode } from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { messageBodyText, messageImageIds, messageQuotes, messageText } from '@/domain/messages'
import type { Id, Message } from '@/domain/models'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { formatClock } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { NodeActionKind } from '@/domain/node-ops/actions'
import { isStreamingIn, useWorkspaceStore } from '@/stores/workspace-store'
import { MessageNotes } from './MessageNotes'
import { bodyProps } from './note-anchor'
import { useAssetUrls } from './useAssetUrls'
import { useNoteHighlights } from './useNoteHighlights'
import { useThrottledValue } from './useThrottledValue'

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

const MessageBubble = memo(function MessageBubble({
  message,
  assetUrls,
  onAction,
  isLast,
  canRegenerate,
}: {
  message: Message
  assetUrls: string[]
  onAction: (kind: NodeActionKind, messageId: Id) => void
  isLast: boolean
  canRegenerate: boolean
}) {
  const isUser = message.role === 'user'
  const text = messageText(message)
  const quotes = messageQuotes(message)
  const body = messageBodyText(message)
  const regenerate = useWorkspaceStore((state) => state.regenerate)
  const notes = useWorkspaceStore((state) => state.notesByMessage[message.id]) ?? []

  // 正文容器的 ref 同时是笔记锚点的基准：`data-message-body` 标出「正文是哪一段文本」，
  // 框选时按它数下标，渲染笔记时按它还原区间（见 note-anchor.ts）
  const bodyRef = useRef<HTMLDivElement>(null)
  useNoteHighlights(bodyRef, message.id, notes)

  return (
    <div
      data-message-id={message.id}
      className={cn('group/message flex flex-col gap-1', isUser ? 'items-end' : 'items-stretch')}
    >
      <div
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
                className="whitespace-pre-wrap rounded-md border-l-2 border-accent/40 bg-canvas/40 px-2.5 py-1.5 text-xs leading-relaxed text-muted"
              >
                {quote}
              </blockquote>
            ))}
            {body ? (
              <p className="whitespace-pre-wrap text-base leading-relaxed text-ink">{body}</p>
            ) : null}
          </div>
        ) : (
          <div ref={bodyRef} {...bodyProps(message.id)}>
            <MarkdownView content={text} />
          </div>
        )}
        <MessageImages urls={assetUrls} />
      </div>

      <MessageNotes notes={notes} align={isUser ? 'end' : 'start'} />

      {message.meta?.error ? (
        <div className="flex flex-col gap-1 px-1 text-2xs text-danger">
          <div className="flex flex-wrap items-center gap-2">
            <span>生成中断：{message.meta.error}</span>
            {isLast ? (
              <button
                type="button"
                onClick={() => void regenerate(message.nodeId, message.id)}
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
            onClick={() => void regenerate(message.nodeId, message.id)}
          >
            重新生成
          </MessageAction>
        ) : null}
      </div>
    </div>
  )
})

function StreamingBubble({ nodeId }: { nodeId: Id }) {
  const streaming = useWorkspaceStore((state) => state.streaming)
  const regenerate = useWorkspaceStore((state) => state.regenerate)
  const text = useThrottledValue(streaming?.text ?? '', 70)

  // 这一轮属于别的节点时不在这里渲染，否则切到别的节点还能看见它的「正在思考」
  if (!streaming || streaming.nodeId !== nodeId) return null

  // 失败得连一个字都没吐出来时不会有消息落库，错误只能挂在这一轮上：直接给个重来的入口
  if (streaming.error) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl rounded-bl-sm border border-danger/30 bg-danger-soft/40 px-3.5 py-2.5 text-2xs text-danger">
        <span>生成中断：{streaming.error}</span>
        <button
          type="button"
          onClick={() => void regenerate(nodeId)}
          className="rounded-sm border border-danger/40 px-1.5 py-0.5 transition-colors hover:bg-danger-soft"
        >
          重新生成
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="rounded-xl rounded-bl-sm border border-accent/20 bg-surface/70 px-3.5 py-3">
        {text ? (
          <MarkdownView content={text} />
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:300ms]" />
            </span>
            正在思考…
          </div>
        )}
        {text ? (
          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-accent" />
        ) : null}
      </div>
    </div>
  )
}

export function MessageList({ nodeId }: { nodeId: Id }) {
  const messages = useWorkspaceStore((state) => state.messagesByNode[nodeId]) ?? []
  const applyAction = useWorkspaceStore((state) => state.applyAction)
  const streamingHere = useWorkspaceStore((state) => isStreamingIn(state.streaming, nodeId))
  const viewportRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const idsKey = messages.flatMap((message) => messageImageIds(message)).join(',')
  const assetUrls = useAssetUrls(idsKey)
  const lastIndex = messages.length - 1

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !stickToBottom.current) return
    viewport.scrollTop = viewport.scrollHeight
  }, [messages.length, nodeId])

  useEffect(() => {
    stickToBottom.current = true
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [nodeId])

  return (
    <div
      ref={viewportRef}
      onScroll={(event) => {
        const element = event.currentTarget
        stickToBottom.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 96
      }}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
          <p className="text-sm text-muted">还没有对话</p>
          <p className="max-w-[220px] text-xs leading-relaxed text-faint">
            对话就是节点的内容，标题与摘要都由它生成。
          </p>
        </div>
      ) : null}

      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={message}
          assetUrls={messageImageIds(message)
            .map((id) => assetUrls[id])
            .filter((url): url is string => Boolean(url))}
          onAction={(kind, messageId) => void applyAction(kind, nodeId, messageId)}
          isLast={index === lastIndex}
          canRegenerate={index === lastIndex && !streamingHere}
        />
      ))}

      <StreamingBubble nodeId={nodeId} />
    </div>
  )
}