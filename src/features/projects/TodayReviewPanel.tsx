import { Brain, ChevronRight } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { Project } from '@/domain/models'
import { useReviewStore } from '@/stores/review-store'

/**
 * 首页「今日复习」面板：到期 N / 逾期 N，点进对应项目的复习中心。
 *
 * 通知预算在这里收口：**队列封顶在 `buildReviewQueue`（20/天），这里保证
 * 每天最多提示一次** —— 反复弹的提醒等于训练用户忽略提醒。
 */
export function TodayReviewPanel({ projects }: { projects: Project[] }) {
  const { t } = useTranslation('projects')
  const navigate = useNavigate()
  const summaries = useReviewStore((state) => state.summaries)
  const total = useReviewStore((state) => state.total)
  const loaded = useReviewStore((state) => state.loaded)
  const load = useReviewStore((state) => state.load)

  // 挂载即刷新数据；D11 决定：首页取消重复的到期 toast 弹窗，不反复占用注意力
  useEffect(() => {
    void load()
  }, [load])

  if (!loaded || total.due === 0) return null

  const nameOf = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? t('today.deletedProject')
  const rows = Object.entries(summaries).filter(([, stats]) => stats.due > 0)

  return (
    <div className="mt-5 rounded-lg border border-accent/25 bg-accent-soft/20 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-medium text-ink">{t('today.title')}</h2>
        <span className="text-xs text-muted">
          {t('today.due')} <span className="tabular-nums text-ink-soft">{total.due}</span>
          {total.overdue > 0 ? (
            <>
              {' '}
              {t('today.overdueHeading')} <span className="tabular-nums text-danger">{total.overdue}</span>
            </>
          ) : null}
        </span>
      </div>

      <ul className="mt-2.5 flex flex-col gap-1">
        {rows.map(([projectId, stats]) => (
          <li key={projectId}>
            <button
              type="button"
              onClick={() => navigate(`/p/${projectId}?view=review`)}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted transition-colors hover:bg-elevated hover:text-ink"
            >
              <span className="min-w-0 flex-1 truncate">{nameOf(projectId)}</span>
              <span className="shrink-0 text-2xs">
                {t('today.due')} <span className="tabular-nums">{stats.due}</span>
                {stats.overdue > 0 ? (
                  <>
                    {' '}
                    {t('today.overdueRow')} <span className="tabular-nums text-danger">{stats.overdue}</span>
                  </>
                ) : null}
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}