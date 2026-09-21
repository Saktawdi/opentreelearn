import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getRepositories } from '@/data'
import type { Id, Node } from '@/domain/models'
import { reviewStats, type ReviewDueSummary } from '@/domain/review/schedule'

/**
 * 跨项目的复习概况：首页「今日复习」面板用。
 *
 * 数据直接从 `nodes.listAll()` 现算，不落库、不进同步 —— 到期数是一个
 * 随时间变化的派生值，存下来只会过期。
 *
 * `loaded` 只表示「是否已经有过一次结果」，**不是节流开关**：它在 store 里
 * 常驻内存，跨组件挂载存活，拿它跳过刷新会让面板一直显示上次离开首页时的
 * 数字（复习完回来还是「到期 3」）。
 */
interface ReviewState {
  /** projectId -> 该项目的到期 / 逾期数 */
  summaries: Record<Id, ReviewDueSummary>
  /** 所有项目合计 */
  total: ReviewDueSummary
  loaded: boolean
  /** 读节点现算一次；已加载过也照算（回首页要看到最新数字） */
  load: () => Promise<void>
  reset: () => void
}

const EMPTY: ReviewDueSummary = { due: 0, overdue: 0 }

/** 纯计算：按项目分组算到期 / 逾期，抽出便于单测与复用。 */
export function summarizeByProject(
  nodes: Node[],
  now: number,
): { summaries: Record<Id, ReviewDueSummary>; total: ReviewDueSummary } {
  const byProject = new Map<Id, Node[]>()
  for (const node of nodes) {
    const bucket = byProject.get(node.projectId)
    if (bucket) {
      bucket.push(node)
    } else {
      byProject.set(node.projectId, [node])
    }
  }

  const summaries: Record<Id, ReviewDueSummary> = {}
  const total: ReviewDueSummary = { due: 0, overdue: 0 }
  for (const [projectId, projectNodes] of byProject) {
    const stats = reviewStats(projectNodes, now)
    if (stats.due > 0) summaries[projectId] = stats
    total.due += stats.due
    total.overdue += stats.overdue
  }
  return { summaries, total }
}

export const useReviewStore = create<ReviewState>()(
  immer((set) => ({
    summaries: {},
    total: EMPTY,
    loaded: false,

    load: async () => {
      const nodes = await getRepositories().nodes.listAll()
      const { summaries, total } = summarizeByProject(nodes, Date.now())

      set((state) => {
        state.summaries = summaries
        state.total = total
        state.loaded = true
      })
    },

    reset: () => {
      set((state) => {
        state.summaries = {}
        state.total = EMPTY
        state.loaded = false
      })
    },
  })),
)