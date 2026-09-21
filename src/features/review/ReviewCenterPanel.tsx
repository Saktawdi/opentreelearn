import { CalendarClock, ChevronRight, Play, RotateCcw } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { buildReviewQueue } from '@/domain/review/queue'
import { GRADE_ACTION_LABEL, reviewStats } from '@/domain/review/schedule'
import { useDecayClock } from '@/features/chat/useDecayClock'
import { cn } from '@/lib/utils'
import { currentReviewItem, useWorkspaceStore } from '@/stores/workspace-store'

/**
 * 复习中心面板：贴在复习中心的对话上方。
 *
 * 复习是「混合模式」：这里出计划与回忆题、看队列进度；真正完成复习要回到
 * 原节点对话里（见 ReviewSessionBar），评分回流到原节点的卡片上。
 */
export function ReviewCenterPanel() {
  const nodes = useWorkspaceStore((state) => state.nodes)
  const session = useWorkspaceStore((state) => state.reviewSession)
  const selectNode = useWorkspaceStore((state) => state.selectNode)
  const startSession = useWorkspaceStore((state) => state.startReviewSession)
  const endSession = useWorkspaceStore((state) => state.endReviewSession)

  const now = useDecayClock()
  const stats = useMemo(() => reviewStats(nodes, now), [nodes, now])
  const queue = useMemo(() => buildReviewQueue(nodes, now), [nodes, now])
  const titleOf = (nodeId: string) => nodes.find((node) => node.id === nodeId)?.title ?? '已删除'
  const current = currentReviewItem(session)

  const begin = async () => {
    const items = await startSession()
    if (items.length === 0) {
      toast.info('今天没有到期的复习')
      return
    }
    const relearn = items.filter((item) => item.mode === 'relearn').length
    toast.success(
      relearn > 0
        ? `开始复习：共 ${items.length} 个主题（其中 ${relearn} 个需要重新学习）`
        : `开始复习：共 ${items.length} 个主题`,
    )
  }

  const summary = session?.finishedAt ? (
    <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-xs text-ink-soft">
      <p className="font-medium text-ink">本次复习完成</p>
      <p className="mt-1 leading-relaxed">
        {session.items.length} 个主题：
        {session.items.map((item, index) => (
          <span key={item.nodeId} className="whitespace-nowrap">
            {index > 0 ? ' · ' : ''}
            《{titleOf(item.nodeId)}》
            {session.results[item.nodeId]
              ? ` ${GRADE_ACTION_LABEL[session.results[item.nodeId]]}`
              : ' 未评分'}
          </span>
        ))}
      </p>
    </div>
  ) : null

  return (
    <div className="shrink-0 border-b border-line/60 bg-surface/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
          <CalendarClock className="h-3.5 w-3.5 text-accent" />
          今日复习
        </span>
        <span className="text-xs text-muted">
          到期 <span className="tabular-nums text-ink-soft">{stats.due}</span> · 逾期{' '}
          <span className={cn('tabular-nums', stats.overdue > 0 ? 'text-danger' : 'text-ink-soft')}>
            {stats.overdue}
          </span>
        </span>

        <span className="ml-auto flex items-center gap-1.5">
          {session && !session.finishedAt ? (
            <>
              <span className="text-2xs text-muted">
                进行中 {session.cursor + 1}/{session.items.length}
              </span>
              {current ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => selectNode(current.nodeId)}
                >
                  {current.mode === 'relearn' ? '去重新学习' : '去复习'}
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={endSession}>
                结束
              </Button>
            </>
          ) : (
            <>
              {session?.finishedAt ? (
                <Button variant="ghost" size="sm" onClick={endSession}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  收起小结
                </Button>
              ) : null}
              <Button
                variant={stats.due > 0 ? 'primary' : 'secondary'}
                size="sm"
                disabled={stats.due === 0}
                onClick={() => void begin()}
              >
                <Play className="h-3.5 w-3.5" />
                开始复习
              </Button>
            </>
          )}
        </span>
      </div>

      {summary ? <div className="mt-2.5">{summary}</div> : null}

      {!session && queue.length > 0 ? (
        <ul className="mt-2.5 flex flex-col gap-1">
          {queue.slice(0, 6).map((item) => (
            <li key={item.nodeId} className="flex items-center gap-2 text-xs text-muted">
              <span
                className={cn(
                  'rounded-full border px-1.5 py-0.5 text-2xs',
                  item.mode === 'relearn'
                    ? 'border-danger/35 bg-danger-soft text-danger'
                    : 'border-line bg-elevated text-muted',
                )}
              >
                {item.mode === 'relearn' ? '重新学习' : '复习'}
              </span>
              <button
                type="button"
                onClick={() => selectNode(item.nodeId)}
                className="min-w-0 flex-1 truncate text-left transition-colors hover:text-ink"
              >
                《{titleOf(item.nodeId)}》
              </button>
              <span className="shrink-0 text-2xs text-faint">
                {item.retention === null ? '未复习过' : `保持率 ${Math.round(item.retention * 100)}%`}
              </span>
            </li>
          ))}
          {queue.length > 6 ? (
            <li className="text-2xs text-faint">还有 {queue.length - 6} 个…</li>
          ) : null}
        </ul>
      ) : null}

      {!session && queue.length === 0 ? (
        <p className="mt-2 text-2xs leading-relaxed text-faint">
          今天没有到期的复习。想让某个主题进入复习计划，先去它的对话里生成一次学习摘要。
        </p>
      ) : null}
    </div>
  )
}