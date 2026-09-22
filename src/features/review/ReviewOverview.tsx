import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Play,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Id, Node } from '@/domain/models'
import {
  buildReviewQueue,
  defaultSelection,
  earlyReviewCandidates,
  MAX_BATCH_SIZE,
  type ReviewQueueItem,
} from '@/domain/review/queue'
import { reviewReasonOf, retentionLabel } from '@/domain/review/enrollment'
import { useDecayClock } from '@/features/chat/useDecayClock'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ReviewSessionRecord } from '@/domain/review/session'

interface ReviewOverviewProps {
  nodes: Node[]
  hasChatModel: boolean
  activeSession: ReviewSessionRecord | null
  onStartBatch: (items: ReviewQueueItem[]) => void
  onResumeSession: () => void
  onEndActiveSession: () => void
  onInspectNodeSource?: (nodeId: Id) => void
  onOpenLegacyHistory?: () => void
  hasLegacyCenters?: boolean
}

/**
 * 复习概览页面：
 * - 明确回答「复习什么、为什么、从哪里开始」；
 * - 默认选中推荐的 3 个主题，允许勾选调整（上限 20 个）；
 * - 区分到期复习与提前复习；
 * - 存在未完成会话时优先显示「继续复习」；
 * - 绝不宣称未经测量的虚假时间（如预计 3 分钟）。
 */
export function ReviewOverview({
  nodes,
  hasChatModel,
  activeSession,
  onStartBatch,
  onResumeSession,
  onEndActiveSession,
  onInspectNodeSource,
  onOpenLegacyHistory,
  hasLegacyCenters = false,
}: ReviewOverviewProps) {
  const now = useDecayClock()

  // 全部到期候选与提前复习候选
  const dueQueue = useMemo(() => buildReviewQueue(nodes, now), [nodes, now])
  const earlyQueue = useMemo(() => earlyReviewCandidates(nodes, now), [nodes, now])

  // 默认选中推荐的 3 个
  const [selectedIds, setSelectedIds] = useState<Set<Id>>(() => {
    const def = defaultSelection(dueQueue)
    return new Set(def.map((i) => i.nodeId))
  })

  // 是否展开查看更多提前复习项
  const [showEarly, setShowEarly] = useState(false)

  const toggleSelect = (nodeId: Id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        if (next.size >= MAX_BATCH_SIZE) return prev
        next.add(nodeId)
      }
      return next
    })
  }

  const selectedItems = useMemo(() => {
    const map = new Map<Id, ReviewQueueItem>()
    for (const item of [...dueQueue, ...earlyQueue]) {
      map.set(item.nodeId, item)
    }
    const result: ReviewQueueItem[] = []
    for (const id of selectedIds) {
      const item = map.get(id)
      if (item) result.push(item)
    }
    return result
  }, [selectedIds, dueQueue, earlyQueue])

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  // 未完成会话的简述
  const activeProgress = useMemo(() => {
    if (!activeSession) return null
    const done = activeSession.items.filter((i) => i.phase === 'done').length
    const total = activeSession.items.length
    return { done, total }
  }, [activeSession])

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-12 max-w-4xl mx-auto w-full">
      {/* 存在未完成会话横幅 */}
      {activeSession && activeProgress && (
        <div className="mb-6 rounded-xl border border-accent/40 bg-accent-soft/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">当前有尚未完成的复习</h3>
              <p className="mt-1 text-xs text-muted">
                本批已完成 {activeProgress.done} / {activeProgress.total} 个主题，可随时恢复同一题继续作答。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onEndActiveSession}>
                结束本次
              </Button>
              <Button variant="primary" size="sm" onClick={onResumeSession}>
                继续复习
                <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 标题说明 */}
      <div className="mb-6">
        <h2 className="text-lg font-bold tracking-tight text-ink">
          {dueQueue.length > 0
            ? `今天有 ${dueQueue.length} 个主题适合巩固`
            : '当前没有到期的复习主题'}
        </h2>
        <p className="mt-1 text-xs text-muted">
          {dueQueue.length > 0
            ? '默认推荐前 3 个开始，你可以根据需要勾选调整。'
            : '可以查看已加入计划的安排，或选择已学过的主题提前复习。'}
        </p>
      </div>

      {/* 候选列表 */}
      {dueQueue.length > 0 ? (
        <div className="space-y-2">
          {dueQueue.map((item) => {
            const node = nodeMap.get(item.nodeId)
            if (!node) return null
            const isSelected = selectedIds.has(item.nodeId)
            const reason = reviewReasonOf(node, now)
            const retention = retentionLabel(node, now)

            return (
              <div
                key={item.nodeId}
                className={cn(
                  'flex items-center justify-between rounded-xl border p-3.5 transition-colors',
                  isSelected
                    ? 'border-accent/60 bg-surface shadow-xs'
                    : 'border-line/60 bg-surface/40 hover:border-line-strong',
                )}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(item.nodeId)}
                    className="h-4 w-4 rounded border-line text-accent focus:ring-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-xs text-ink truncate">
                        {node.title}
                      </span>
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-2xs font-medium',
                          reason.kind === 'relearn'
                            ? 'bg-danger-soft text-danger border border-danger/30'
                            : 'bg-elevated text-muted border border-line/60',
                        )}
                      >
                        {reason.label}
                      </span>
                    </div>
                    <div className="mt-0.5 text-2xs text-faint truncate">
                      {retention}
                      {node.summary ? ` · ${node.summary}` : ''}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 ml-4">
                  {onInspectNodeSource ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onInspectNodeSource(node.id)}
                      className="h-7 text-2xs text-muted hover:text-ink gap-1"
                    >
                      <BookOpen className="h-3 w-3" />
                      查看资料
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-line/60 bg-surface/30 p-8 text-center text-xs text-muted">
          <CheckCircle2 className="mx-auto h-8 w-8 text-success/80 mb-2" />
          <p>太棒了，今天计划内的所有复习已全部搞定！</p>
        </div>
      )}

      {/* 次级提前复习展开 */}
      {earlyQueue.length > 0 && (
        <div className="mt-8 border-t border-line/50 pt-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-ink">
              其他已计划主题（提前复习 · {earlyQueue.length}）
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowEarly((v) => !v)}
              className="text-2xs text-accent"
            >
              {showEarly ? '收起' : '展开选择'}
            </Button>
          </div>

          {showEarly && (
            <div className="space-y-2 mt-2">
              {earlyQueue.map((item) => {
                const node = nodeMap.get(item.nodeId)
                if (!node) return null
                const isSelected = selectedIds.has(item.nodeId)
                return (
                  <div
                    key={item.nodeId}
                    className={cn(
                      'flex items-center justify-between rounded-xl border p-3 transition-colors',
                      isSelected
                        ? 'border-accent/60 bg-surface'
                        : 'border-line/60 bg-surface/40 hover:border-line-strong',
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(item.nodeId)}
                        className="h-4 w-4 rounded border-line text-accent focus:ring-accent"
                      />
                      <span className="font-medium text-xs text-ink truncate">
                        {node.title}
                      </span>
                      <span className="rounded bg-elevated px-1.5 py-0.5 text-2xs text-muted border border-line/40">
                        提前复习
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 历史复习中心记录入口（D12 / 8.1 规范） */}
      {hasLegacyCenters && onOpenLegacyHistory && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onOpenLegacyHistory}
            className="text-2xs text-faint hover:text-accent underline transition-colors"
          >
            查看旧复习中心历史记录
          </button>
        </div>
      )}

      {/* 底部动作条 */}
      <div className="mt-8 sticky bottom-4 z-10 flex items-center justify-between rounded-xl border border-line bg-surface/95 p-4 shadow-panel backdrop-blur-md">
        <div className="text-xs text-muted">
          已选择 <span className="font-semibold text-ink tabular-nums">{selectedIds.size}</span> 个主题
          {selectedIds.size >= MAX_BATCH_SIZE && (
            <span className="ml-2 text-2xs text-accent">（单批最多 20 个）</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!hasChatModel ? (
            <span className="text-2xs text-danger">未配置对话模型，请先去配置</span>
          ) : null}
          <Button
            variant="primary"
            size="md"
            disabled={selectedIds.size === 0 || !hasChatModel}
            onClick={() => onStartBatch(selectedItems)}
            className="gap-1.5"
          >
            <Play className="h-4 w-4" />
            开始这 {selectedIds.size} 个
          </Button>
        </div>
      </div>
    </div>
  )
}