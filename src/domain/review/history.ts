import type { Id, ReviewGrade } from '@/domain/models'
import type { ReviewSessionRecord } from './session'

/**
 * 主题的历史复习记录（纯函数）：`get_review_history` 工具的数据口径。
 *
 * 数据源是**历史会话文档**：已确认的项带档位与该次确认写入的薄弱点；跳过的项
 * 如实保留 —— 跳过是用户对这一项的选择，既不能读成「没复习」也不能读成「没掌握」。
 * 进行中的项没有 result、也没到 skipped，天然不产生行，不需要调用方排除当前会话。
 */

export interface ReviewHistoryRow {
  /** 确认（或跳过）时间，epoch ms */
  at: number
  /** 已确认项的档位；跳过的行没有档位 */
  grade?: ReviewGrade
  /** 该次确认写入的薄弱点（掌握度快照里的，不是现编的） */
  weakPoints?: string[]
  /** 跳过原因 */
  skipped?: string
}

/** 某主题的历史复习行：按时间倒序，`limit` 截断最近 N 条，`total` 给全量数。 */
export function reviewHistoryForNode(
  sessions: ReviewSessionRecord[],
  nodeId: Id,
  limit = 10,
): { total: number; rows: ReviewHistoryRow[] } {
  const rows: ReviewHistoryRow[] = []
  for (const session of sessions) {
    for (const item of session.items) {
      if (item.nodeId !== nodeId) continue
      if (item.result) {
        rows.push({
          at: item.result.confirmedAt,
          grade: item.result.grade,
          ...(item.result.masteryAfter.weakPoints?.length
            ? { weakPoints: item.result.masteryAfter.weakPoints }
            : {}),
        })
      } else if (item.phase === 'skipped') {
        rows.push({ at: item.updatedAt, skipped: item.skipReason ?? '用户跳过' })
      }
    }
  }
  rows.sort((a, b) => b.at - a.at)
  return { total: rows.length, rows: rows.slice(0, Math.max(1, limit)) }
}
