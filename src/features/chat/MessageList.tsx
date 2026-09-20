import { GitBranch, Waypoints } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { messageImageIds, messageText } from '@/domain/messages'
import type { Id, Message } from '@/domain/models'
import { MarkdownView } from '@/lib/markdown/MarkdownView'
import { formatClock } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { NodeActionKind } from '@/domain/node-ops/actions'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAssetUrls } from './useAssetUrls'
import { useThrottledValue } from './useThrottledValue'

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
  canRetry,
}: {
  message: Message
  assetUrls: string[]
  onAction: (kind: NodeActionKind, messageId: Id) => void
  canRetry: boolean
}) {
  const isUser = message.role === 'user'
  const text = messageText(message)
  const retryLast = useWorkspaceStore((state) => state.retryLast)

  return (
    <div className={cn('group/message flex flex-col gap-1', isUser ? 'items-end' : 'items-stretch')}>
      <div
        className={cn(
          'max-w-full',
          isUser
            ? 'max-w-[86%] rounded-2xl rounded-br-md border border-line/50 bg-elevated/90 px-3.5 py-2.5'
            : 'rounded-2xl rounded-bl-md border border-line/40 bg-surface/70 px-3.5 py-3',
        )}
      >
        {isUser ? (
          text ? (
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{text}</p>
          ) : null
        ) : (
          <MarkdownView content={text} />
        )}
        <MessageImages urls={assetUrls} />
      </div>

      {message.meta?.error ? (
        <div className="flex flex-col gap-1 px-1 text-[11.5px] text-danger">
          <div className="flex flex-wrap items-center gap-2">
            <span>生成中断：{message.meta.error}</span>
            {canRetry ? (
              <button
                type="button"
                onClick={() => void retryLast(message.nodeId)}
                className="rounded border border-danger/40 px-1.5 py-0.5 transition-colors hover:bg-danger-soft"
              >
                重新生成
              </button>
            ) : null}
          </div>
          {message.meta.errorHint ? (
            <p className="text-[11px] leading-relaxed text-muted/90">{message.meta.errorHint}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 px-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100">
        <span className="text-[10.5px] text-muted/70">{formatClock(message.createdAt)}</span>
        {isUser ? (
          <>
            <Tooltip label="以这条消息为起点，在下方新建继承上下文的节点">
              <button
                type="button"
                onClick={() => onAction('branch', message.id)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted transition-colors hover:bg-elevated hover:text-ink"
              >
                <GitBranch className="h-3 w-3" />
                分支
              </button>
            </Tooltip>
            <Tooltip label="以这条消息为起点，横向新建继承上下文的节点">
              <button
                type="button"
                onClick={() => onAction('diverge', message.id)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted transition-colors hover:bg-elevated hover:text-ink"
              >
                <Waypoints className="h-3 w-3" />
                发散
              </button>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  )
})

function StreamingBubble() {
  const streaming = useWorkspaceStore((state) => state.streaming)
  const text = useThrottledValue(streaming?.text ?? '', 70)

  if (!streaming) return null

  return (
    <div className="flex flex-col gap-1">
      <div className="rounded-2xl rounded-bl-md border border-accent/20 bg-surface/70 px-3.5 py-3">
        {text ? (
          <MarkdownView content={text} />
        ) : (
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
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
      {streaming.error ? (
        <p className="px-1 text-[11.5px] text-danger">{streaming.error}</p>
      ) : null}
    </div>
  )
}

export function MessageList({ nodeId }: { nodeId: Id }) {
  const messages = useWorkspaceStore((state) => state.messagesByNode[nodeId]) ?? []
  const applyAction = useWorkspaceStore((state) => state.applyAction)
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
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <p className="text-[13px] text-muted">这里是这个节点的对话。</p>
          <p className="max-w-[240px] text-[11.5px] leading-relaxed text-muted/70">
            对话本身就是节点的内容，AI 会据此生成摘要与标题。
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
          canRetry={index === lastIndex}
        />
      ))}

      <StreamingBubble />
    </div>
  )
}