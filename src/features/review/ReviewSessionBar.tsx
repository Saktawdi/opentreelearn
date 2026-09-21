import { Check, ChevronRight, Lightbulb, X } from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { messageText } from '@/domain/messages'
import type { Id, ReviewGrade } from '@/domain/models'
import { parseReviewRating } from '@/domain/review/protocol'
import { GRADE_ACTION_LABEL } from '@/domain/review/schedule'
import { resolveThread } from '@/domain/thread/resolve'
import { cn } from '@/lib/utils'
import { currentReviewItem, isStreamingIn, useWorkspaceStore } from '@/stores/workspace-store'

/**
 * 复习会话浮条：复习到某个节点时贴在输入框上方。
 *
 * 「AI 判定 + 一键覆盖」在这里落地：解析导师回答末尾的 `[[rating:x]]` 并把它
 * 预选在档位上，用户点任意一档即完成评分；没有标记时四档都可直接点。
 */
export function ReviewSessionBar({ nodeId }: { nodeId: Id }) {
  const session = useWorkspaceStore((state) => state.reviewSession)
  const node = useWorkspaceStore((state) => state.nodes.find((item) => item.id === nodeId))
  const messages = useWorkspaceStore((state) => state.messagesByNode[nodeId])
  const rateReview = useWorkspaceStore((state) => state.rateReview)
  const advance = useWorkspaceStore((state) => state.advanceReviewSession)
  const end = useWorkspaceStore((state) => state.endReviewSession)
  const sendMessage = useWorkspaceStore((state) => state.sendMessage)
  const streamingHere = useWorkspaceStore((state) => isStreamingIn(state.streaming, nodeId))

  const item = currentReviewItem(session)
  const rated = session && item ? session.results[item.nodeId] : undefined

  // AI 判定只认显示路径末条回答上的标记，且必须是**本次会话开始之后**产生的：
  // 否则上一轮复习留下的旧判定会被预选到这一题上，像是 AI 没看新回答就下了结论
  const startedAt = session?.startedAt ?? 0
  const suggestion = useMemo(() => {
    if (!node || !messages || messages.length === 0) return null
    if (startedAt === 0) return null
    const path = resolveThread(node, messages).path
    const lastAssistant = [...path].reverse().find((message) => message.role === 'assistant')
    if (!lastAssistant || lastAssistant.createdAt < startedAt) return null
    return parseReviewRating(messageText(lastAssistant))
  }, [node, messages, startedAt])

  if (!session || !item || item.nodeId !== nodeId) return null

  const total = session.items.length
  const index = session.cursor + 1
  const label = item.mode === 'relearn' ? '重新学习' : '复习'

  return (
    <div className="shrink-0 border-t border-accent/25 bg-accent-soft/25 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs font-medium text-ink">
          {label}会话 {index}/{total}
        </span>
        <span className="text-2xs text-muted">
          {item.retention === null
            ? '还没复习过'
            : `保持率约 ${Math.round(item.retention * 100)}%`}
          {item.dueAt !== null ? ` · 到期于 ${new Date(item.dueAt).toLocaleDateString('zh-CN')}` : ''}
        </span>
        {node?.mastery?.weakPoints && node.mastery.weakPoints.length > 0 ? (
          <span className="min-w-0 truncate text-2xs text-faint">
            上次的薄弱点：{node.mastery.weakPoints.join('、')}
          </span>
        ) : null}

        <span className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={streamingHere}
            onClick={() =>
              void sendMessage(nodeId, [
                {
                  type: 'text',
                  text:
                    item.mode === 'relearn'
                      ? '先把这个主题的关键点讲给我，再让我复述一遍。'
                      : '先考我一个回忆题，我凭记忆答，你再点评。',
                },
              ])
            }
          >
            <Lightbulb className="h-3.5 w-3.5" />
            {item.mode === 'relearn' ? '补讲' : '出题'}
          </Button>
          <Button variant="ghost" size="sm" onClick={end}>
            <X className="h-3.5 w-3.5" />
            结束
          </Button>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-2xs text-muted">评分</span>
        {(['again', 'hard', 'good', 'easy'] as ReviewGrade[]).map((grade) => (
          <button
            key={grade}
            type="button"
            title={`${GRADE_ACTION_LABEL[grade]}（${grade}）`}
            onClick={() => void rateReview(nodeId, grade)}
            className={cn(
              'relative rounded-md border px-2.5 py-1 text-xs transition-colors',
              rated === grade
                ? 'border-accent bg-accent text-accent-ink'
                : suggestion === grade
                  ? 'border-accent/60 bg-accent-soft text-accent hover:bg-accent/20'
                  : 'border-line text-ink-soft hover:border-line-strong hover:bg-elevated',
            )}
          >
            {GRADE_ACTION_LABEL[grade]}
            {suggestion === grade && rated !== grade ? (
              <span className="ml-1 text-2xs opacity-80">AI</span>
            ) : null}
          </button>
        ))}

        {rated ? (
          <span className="ml-auto flex items-center gap-2 text-2xs text-muted">
            <span className="inline-flex items-center gap-1 text-success">
              <Check className="h-3 w-3" />
              已记录「{GRADE_ACTION_LABEL[rated]}」
            </span>
            <Button variant="secondary" size="sm" onClick={advance}>
              {index >= total ? '完成本次复习' : '下一题'}
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </span>
        ) : suggestion ? (
          <span className="ml-auto text-2xs text-muted">
            AI 判定：{GRADE_ACTION_LABEL[suggestion]} · 可直接改选覆盖
          </span>
        ) : null}
      </div>
    </div>
  )
}