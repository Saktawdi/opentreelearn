import { ChevronRight, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Id } from '@/domain/models'
import { studiedDaysAgo } from '@/domain/review/digest'
import { buildReviewQueue } from '@/domain/review/queue'
import { resolveThread } from '@/domain/thread/resolve'
import { useDecayClock } from '@/features/chat/useDecayClock'
import { useWorkspaceStore } from '@/stores/workspace-store'

/**
 * 顺手复习：学完一个节点、刚好有到期旧节点时，提示「顺手复习一下 N 天前学的《X》」。
 *
 * 刻意放在学习流的末尾而不是做成独立任务：复习最贵的是「专门腾出时间」，
 * 顺手把它嵌进刚学完的那一刻，成本最低。可关闭，且不打扰当前对话。
 *
 * 「刚学完」= 最近一轮回答就在这几分钟内（`JUST_STUDIED_WINDOW_MS`），
 * 而不是「这个节点有对话」—— 否则每次打开旧节点都会被拦一下。
 * 每多一轮回答重新给一次机会；关掉之后这一轮不再出现。
 */
/** 最近一轮回答距今多久算「刚学完」；超时就说明用户只是回来看旧对话。 */
const JUST_STUDIED_WINDOW_MS = 5 * 60 * 1000

export function ReviewNudge({ nodeId }: { nodeId: Id }) {
  const node = useWorkspaceStore((state) => state.nodes.find((item) => item.id === nodeId))
  const nodes = useWorkspaceStore((state) => state.nodes)
  const messages = useWorkspaceStore((state) => state.messagesByNode[nodeId])
  const session = useWorkspaceStore((state) => state.reviewSession)
  const startSession = useWorkspaceStore((state) => state.startReviewSession)
  const now = useDecayClock(30_000)

  const [dismissedRound, setDismissedRound] = useState(-1)

  const { rounds, lastAssistantAt } = useMemo(() => {
    if (!node || !messages) return { rounds: 0, lastAssistantAt: 0 }
    const path = resolveThread(node, messages).path
    const assistants = path.filter((message) => message.role === 'assistant')
    return {
      rounds: assistants.length,
      lastAssistantAt: assistants.at(-1)?.createdAt ?? 0,
    }
  }, [node, messages])

  const suggestion = useMemo(() => {
    // 只被「进行中」的会话挡住：走完但还没收起的小结会话不该拦住顺手复习
    const activeSession = Boolean(session && !session.finishedAt)
    if (activeSession || rounds === 0 || rounds === dismissedRound) return null
    if (now - lastAssistantAt > JUST_STUDIED_WINDOW_MS) return null
    const queue = buildReviewQueue(nodes, now)
    const first = queue.find((item) => item.nodeId !== nodeId)
    if (!first) return null
    const target = nodes.find((node) => node.id === first.nodeId)
    if (!target) return null
    return { node: target, days: studiedDaysAgo(target, now) }
  }, [session, rounds, dismissedRound, nodes, nodeId, now, lastAssistantAt])

  if (!suggestion) return null

  const days = suggestion.days

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line/60 bg-surface/60 px-4 py-2 text-xs text-muted">
      <span className="min-w-0 flex-1 truncate">
        顺手复习一下
        {days !== null && days > 0 ? ` ${days} 天前` : ''}学的《{suggestion.node.title}》？
      </span>
      <button
        type="button"
        // 从这一条切入队列：把它转到队首，剩下的到期节点接着走
        onClick={() => void startSession(suggestion.node.id)}
        className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-accent/40 px-2 py-0.5 text-accent transition-colors hover:bg-accent-soft"
      >
        去复习
        <ChevronRight className="h-3 w-3" />
      </button>
      <button
        type="button"
        aria-label="忽略"
        onClick={() => setDismissedRound(rounds)}
        className="shrink-0 rounded-sm p-0.5 text-faint transition-colors hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}