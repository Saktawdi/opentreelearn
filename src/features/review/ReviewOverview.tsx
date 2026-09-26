import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Play,
  Sparkles,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  /** 打开「自由问答」面板：随口问进度的那类问题不进练习流程 */
  onOpenFreeAsk?: () => void
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
  onOpenFreeAsk,
  hasLegacyCenters = false,
}: ReviewOverviewProps) {
  const { t } = useTranslation('review')
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
              <h3 className="text-sm font-semibold text-ink">{t('overview.bannerTitle')}</h3>
              <p className="mt-1 text-xs text-muted">
                {t('overview.bannerProgress', {
                  done: activeProgress.done,
                  total: activeProgress.total,
                  count: activeProgress.total,
                })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onEndActiveSession}>
                {t('overview.endSession')}
              </Button>
              <Button variant="primary" size="sm" onClick={onResumeSession}>
                {t('overview.resume')}
                <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 标题说明 */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-ink">
            {dueQueue.length > 0
              ? t('overview.headingDue', { count: dueQueue.length })
              : t('overview.headingEmpty')}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {dueQueue.length > 0
              ? t('overview.subDue')
              : t('overview.subEmpty')}
          </p>
        </div>

        {/* 自由问答入口：不需要走一遍练习流程的那类问题（今天学了什么 / 哪些快忘了） */}
        {onOpenFreeAsk ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onOpenFreeAsk}
            title={t('overview.freeAskTitle')}
            className="shrink-0 gap-1.5 text-xs"
          >
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            {t('overview.freeAsk')}
          </Button>
        ) : null}
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
                      {t('overview.viewSource')}
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
          <p>{t('overview.emptyTitle')}</p>
        </div>
      )}

      {/* 次级提前复习展开 */}
      {earlyQueue.length > 0 && (
        <div className="mt-8 border-t border-line/50 pt-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-ink">
              {t('overview.earlyTitle', { count: earlyQueue.length })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowEarly((v) => !v)}
              className="text-2xs text-accent"
            >
              {showEarly ? t('overview.collapse') : t('overview.expand')}
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
                        {t('overview.earlyBadge')}
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
            {t('overview.legacyHistory')}
          </button>
        </div>
      )}

      {/* 底部动作条 */}
      <div className="mt-8 sticky bottom-4 z-10 flex items-center justify-between rounded-xl border border-line bg-surface/95 p-4 shadow-panel backdrop-blur-md">
        <div className="text-xs text-muted">
          {t('overview.selectedPrefix')}{' '}
          <span className="font-semibold text-ink tabular-nums">{selectedIds.size}</span>{' '}
          {t('overview.selectedCount', { count: selectedIds.size })}
          {selectedIds.size >= MAX_BATCH_SIZE && (
            <span className="ml-2 text-2xs text-accent">{t('overview.maxBatchHint')}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!hasChatModel ? (
            <span className="text-2xs text-danger">{t('overview.noChatModel')}</span>
          ) : null}
          <Button
            variant="primary"
            size="md"
            disabled={selectedIds.size === 0 || !hasChatModel}
            onClick={() => onStartBatch(selectedItems)}
            className="gap-1.5"
          >
            <Play className="h-4 w-4" />
            {t('overview.startButton', { count: selectedIds.size })}
          </Button>
        </div>
      </div>
    </div>
  )
}