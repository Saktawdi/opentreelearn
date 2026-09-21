import { Brain, ChevronRight } from 'lucide-react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import type { Project } from '@/domain/models'
import { markNotifiedToday, shouldNotifyToday } from '@/lib/daily-notice'
import { useReviewStore } from '@/stores/review-store'

const NOTICE_KEY = 'today-review'

/**
 * 首页「今日复习」面板：到期 N / 逾期 N，点进对应项目的复习中心。
 *
 * 通知预算在这里收口：**队列封顶在 `buildReviewQueue`（20/天），这里保证
 * 每天最多提示一次** —— 反复弹的提醒等于训练用户忽略提醒。
 */
export function TodayReviewPanel({ projects }: { projects: Project[] }) {
  const navigate = useNavigate()
  const summaries = useReviewStore((state) => state.summaries)
  const total = useReviewStore((state) => state.total)
  const loaded = useReviewStore((state) => state.loaded)
  const load = useReviewStore((state) => state.load)

  // 挂载即刷新、刷新完再判通知：到期数会随着「刚复习完 / 刚生成评估 / 跨天」
  // 变化，而 store 是全局常驻的（loaded 早就为 true 且不会重置），只靠 loaded
  // 判断会一直显示上次离开首页时的旧数字、也不会在跨天时重新提示。
  // 通知的去重交给 daily-notice（每天一次），不依赖「数字变没变」。
  useEffect(() => {
    let cancelled = false
    void load().then(() => {
      if (cancelled) return
      const due = useReviewStore.getState().total.due
      if (due === 0) return
      if (!shouldNotifyToday(NOTICE_KEY)) return
      markNotifiedToday(NOTICE_KEY)
      toast.info(`今天有 ${due} 个主题到期复习`, {
        description: '打开项目即可从复习中心开始',
      })
    })
    return () => {
      cancelled = true
    }
  }, [load])

  if (!loaded || total.due === 0) return null

  const nameOf = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.name ?? '已删除的项目'
  const rows = Object.entries(summaries)

  return (
    <div className="mt-5 rounded-lg border border-accent/25 bg-accent-soft/20 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-medium text-ink">今日复习</h2>
        <span className="text-xs text-muted">
          到期 <span className="tabular-nums text-ink-soft">{total.due}</span>
          {total.overdue > 0 ? (
            <>
              {' '}
              · 逾期 <span className="tabular-nums text-danger">{total.overdue}</span>
            </>
          ) : null}
        </span>
      </div>

      <ul className="mt-2.5 flex flex-col gap-1">
        {rows.map(([projectId, stats]) => (
          <li key={projectId}>
            <button
              type="button"
              onClick={() => navigate(`/p/${projectId}`, { state: { openReviewCenter: true } })}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted transition-colors hover:bg-elevated hover:text-ink"
            >
              <span className="min-w-0 flex-1 truncate">{nameOf(projectId)}</span>
              <span className="shrink-0 text-2xs">
                到期 <span className="tabular-nums">{stats.due}</span>
                {stats.overdue > 0 ? (
                  <>
                    {' '}
                    · 逾期 <span className="tabular-nums text-danger">{stats.overdue}</span>
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