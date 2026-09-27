import { ArrowLeft, CheckCircle2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { GRADE_ACTION_LABEL_KEY } from '@/domain/review/schedule'
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
  // 词表键（grade.*）落在 common：数组形式让 t(`common:${...}`) 能过类型校验
  const { t, i18n } = useTranslation(['review', 'common'])
  const summary = sessionSummary(session)
  const isAllSkipped = summary.done === 0 && summary.skipped > 0

  const formatDue = (timestamp?: number) => {
    if (!timestamp) return t('summary.notScheduled')
    return new Intl.DateTimeFormat(i18n.language, { month: 'numeric', day: 'numeric' }).format(
      new Date(timestamp),
    )
  }

  const joinWeakPoints = (points: string[]) =>
    new Intl.ListFormat(i18n.language, { type: 'unit' }).format(points)

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
          {isAllSkipped ? t('summary.titleEnded') : t('summary.titleDone')}
        </h2>
        <p className="mt-1.5 text-xs text-muted">
          {t('summary.consolidatedPrefix')}{' '}
          <span className="font-semibold text-ink">{summary.done}</span>{' '}
          {t('summary.consolidatedSuffix', { count: summary.done })}
          {summary.skipped > 0 ? t('summary.skippedCount', { count: summary.skipped }) : ''}
          {summary.unfinished > 0
            ? t('summary.unfinishedCount', { count: summary.unfinished })
            : ''}
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
              {t('summary.undoLast')}
            </Button>
          </div>
        ) : null}
      </div>

      {/* 每项明细列表 */}
      <div className="mt-6 space-y-2.5">
        <h3 className="text-xs font-semibold text-muted px-1">{t('summary.listTitle')}</h3>
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
                  {t('summary.weakPoints', {
                    source: row.weakPointsSource,
                    points: joinWeakPoints(row.weakPoints),
                  })}
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-3 shrink-0 text-2xs">
              {row.outcome === 'done' && row.grade ? (
                <>
                  <span className="rounded bg-accent-soft px-2 py-0.5 text-accent font-medium">
                    {t(`common:${GRADE_ACTION_LABEL_KEY[row.grade]}`)}
                  </span>
                  <span className="text-muted">
                    {t('summary.nextDue', { date: formatDue(row.nextDue) })}
                  </span>
                </>
              ) : row.outcome === 'skipped' ? (
                <span className="rounded bg-elevated px-2 py-0.5 text-muted">
                  {t('summary.skipped')}
                </span>
              ) : (
                <span className="rounded bg-danger-soft px-2 py-0.5 text-danger">
                  {t('summary.unfinished')}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 底部动作操作 */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button variant="secondary" size="md" onClick={onStartAnotherBatch}>
          {t('summary.startAnother')}
        </Button>
        <Button variant="primary" size="md" onClick={onReturnToLearning} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          {t('summary.backToWorkspace')}
        </Button>
      </div>
    </div>
  )
}