import { ArrowLeft, CheckCircle2, RotateCcw } from 'lucide-react'
import { GRADE_ACTION_LABEL } from '@/domain/review/schedule'
import { sessionSummary, type ReviewSessionRecord } from '@/domain/review/session'
import { Button } from '@/components/ui/button'

interface ReviewSummaryProps {
  session: ReviewSessionRecord
  onReturnToLearning: () => void
  onStartAnotherBatch: () => void
  onUndoLast?: () => void
  canUndoLast?: boolean
}

/**
 * 复习小结：
 * - 区分已完成数、跳过数、未完成数；
 * - 每项如实列出确认档位与实际排期；
 * - 全部跳过时文案显示「本次已结束」，绝不显示「全部掌握」；
 * - 提供返回学习与再选一批入口；支持在本次小结撤销最后一项评分。
 */
export function ReviewSummary({
  session,
  onReturnToLearning,
  onStartAnotherBatch,
  onUndoLast,
  canUndoLast = false,
}: ReviewSummaryProps) {
  const summary = sessionSummary(session)
  const isAllSkipped = summary.done === 0 && summary.skipped > 0

  const formatDue = (timestamp?: number) => {
    if (!timestamp) return '未排期'
    const date = new Date(timestamp)
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto px-4 py-8 sm:px-12 max-w-3xl mx-auto w-full">
      {/* 头部成就感卡片 */}
      <div className="rounded-2xl border border-line/60 bg-surface p-6 text-center shadow-xs">
        <CheckCircle2
          className={`mx-auto h-12 w-12 ${
            isAllSkipped ? 'text-muted' : 'text-success'
          } mb-3`}
        />
        <h2 className="text-xl font-bold tracking-tight text-ink">
          {isAllSkipped ? '本次复习已结束' : '本次复习完成！'}
        </h2>
        <p className="mt-1.5 text-xs text-muted">
          已巩固 <span className="font-semibold text-ink">{summary.done}</span> 个主题
          {summary.skipped > 0 ? ` · 跳过 ${summary.skipped} 个` : ''}
          {summary.unfinished > 0 ? ` · 未完成 ${summary.unfinished} 个` : ''}
        </p>

        {canUndoLast && onUndoLast ? (
          <div className="mt-3 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={onUndoLast}
              className="text-2xs text-accent"
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              撤销最后一题评分
            </Button>
          </div>
        ) : null}
      </div>

      {/* 每项明细列表 */}
      <div className="mt-6 space-y-2.5">
        <h3 className="text-xs font-semibold text-muted px-1">本批主题小结</h3>
        {summary.rows.map((row) => (
          <div
            key={row.itemId}
            className="flex flex-col sm:flex-row sm:items-center justify-between rounded-xl border border-line/60 bg-surface p-3.5 gap-2"
          >
            <div className="min-w-0 flex-1">
              <span className="font-medium text-xs text-ink truncate block">
                {row.title}
              </span>
              {row.weakPoints && row.weakPoints.length > 0 ? (
                <p className="mt-1 text-2xs text-faint">
                  待巩固（{row.weakPointsSource}）：{row.weakPoints.join('、')}
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-3 shrink-0 text-2xs">
              {row.outcome === 'done' && row.grade ? (
                <>
                  <span className="rounded bg-accent-soft px-2 py-0.5 text-accent font-medium">
                    {GRADE_ACTION_LABEL[row.grade]}
                  </span>
                  <span className="text-muted">
                    下次：{formatDue(row.nextDue)}
                  </span>
                </>
              ) : row.outcome === 'skipped' ? (
                <span className="rounded bg-elevated px-2 py-0.5 text-muted">已跳过</span>
              ) : (
                <span className="rounded bg-danger-soft px-2 py-0.5 text-danger">未完成</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 底部动作操作 */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button variant="secondary" size="md" onClick={onStartAnotherBatch}>
          再选一批
        </Button>
        <Button variant="primary" size="md" onClick={onReturnToLearning} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          返回学习工作区
        </Button>
      </div>
    </div>
  )
}