import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getRepositories } from '@/data'
import type { Id, Node } from '@/domain/models'
import { dueCounts, type DueCounts } from '@/domain/review/enrollment'

/**
 * 跨项目的复习概况：首页「今日复习」面板与项目卡片用。
 *
 * 数据直接从 `nodes.listAll()` 现算，不落库、不进同步 —— 到期数是一个
 * 随时间变化的派生值，存下来只会过期。
 *
 * 统一走 `domain/review/enrollment.ts` 的 `dueCounts`：只有**已加入计划的主题**
 * 才计入到期，未加入的主题无论有没有掌握度都不算逾期，避免一打开应用就看到假到期。
 */
interface ReviewState {
  /** projectId -> 该项目的到期 / 逾期数 */
  summaries: Record<Id, DueCounts>
  /** 所有项目合计 */
  total: DueCounts
  loaded: boolean
  /** 读节点现算一次；已加载过也照算（回首页要看到最新数字） */
  load: () => Promise<void>
  reset: () => void
}

const EMPTY: DueCounts = { due: 0, overdue: 0, scheduled: 0 }

/** 纯计算：按项目分组算到期 / 逾期，抽出便于单测与复用。 */
export function summarizeByProject(
  nodes: Node[],
  now: number,
): { summaries: Record<Id, DueCounts>; total: DueCounts } {
  const byProject = new Map<Id, Node[]>()
  for (const node of nodes) {
    const bucket = byProject.get(node.projectId)
    if (bucket) {
      bucket.push(node)
    } else {
      byProject.set(node.projectId, [node])
    }
  }

  const summaries: Record<Id, DueCounts> = {}
  const total: DueCounts = { due: 0, overdue: 0, scheduled: 0 }
  for (const [projectId, projectNodes] of byProject) {
    const stats = dueCounts(projectNodes, now)
    if (stats.due > 0 || stats.scheduled > 0) summaries[projectId] = stats
    total.due += stats.due
    total.overdue += stats.overdue
    total.scheduled += stats.scheduled
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