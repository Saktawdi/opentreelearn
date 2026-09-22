import type { AssessmentMeta, Node, ReviewEnrollment } from '@/domain/models'
import { MASTERY_STALE_MS } from '@/domain/mastery/aggregate'
import { dueAt, isRelearning, isReviewable, retentionOf, startOfDay } from './schedule'

/**
 * 复习计划资格（纯函数）。
 *
 * 首页统计、复习概览、队列、热力、节点详情全部走这里，口径只有一份 ——
 * 之前「到期数」和「队列里有什么」各算各的，两边一旦漂移，用户就会看到
 * 「到期 6」但列表只有 3 条。
 *
 * 两条规则：
 * 1. **资格 = 活跃 + 有掌握度 + 不是复习中心**（沿用原有 reviewPool 语义）；
 * 2. **加入计划是显式动作**：缺省开关按「有掌握度即已加入」兼容老数据，
 *    新节点显式 `disabled`，生成评估不再偷偷把主题塞进复习计划。
 */

/** 节点的复习计划状态；`unassessed` 表示还没有掌握度，谈不上计划。 */
export type EnrollmentState = 'unassessed' | 'notEnrolled' | 'enrolled'

/**
 * 计划开关的有效值。
 *
 * 缺省时：有掌握度的老数据视为已加入（升级不该让已在复习的主题退出计划），
 * 没有掌握度的视为未加入（没有可复习的东西）。
 */
export function enrollmentOf(node: Node): ReviewEnrollment {
  if (node.reviewEnrollment) return node.reviewEnrollment
  return node.mastery ? 'enabled' : 'disabled'
}

export function enrollmentStateOf(node: Node): EnrollmentState {
  if (!isReviewable(node)) return 'unassessed'
  return enrollmentOf(node) === 'enabled' ? 'enrolled' : 'notEnrolled'
}

/** 是否可以进入复习候选：有掌握度、活跃、且已加入计划。 */
export function isEnrolledForReview(node: Node): boolean {
  return isReviewable(node) && enrollmentOf(node) === 'enabled'
}

/**
 * 首次复习：有掌握度但从未排过卡。
 *
 * 这类节点（历史数据、导入数据、刚加入计划的旧主题）应当立刻进入候选，
 * 但**不能**按 due 时间算逾期 —— `dueAt` 为 null 时早期实现会退化成
 * 「逾期 19700 天」，那是把「没有排期」当成了「很久以前到期」。
 */
export function isFirstReview(node: Node): boolean {
  return isEnrolledForReview(node) && node.review === undefined
}

export function isDueForReview(node: Node, now: number): boolean {
  if (!isEnrolledForReview(node)) return false
  const due = dueAt(node)
  return due === null ? true : due <= now
}

/** 已加入计划但尚未到期：允许用户主动提前复习，界面标注「提前复习」。 */
export function isEarlyReview(node: Node, now: number): boolean {
  return isEnrolledForReview(node) && !isDueForReview(node, now)
}

export interface DueCounts {
  due: number
  /** due 的子集：到期时间早于今天零点；**不能与 due 相加** */
  overdue: number
  /** 已加入计划但今天不到期的主题数（提前复习候选） */
  scheduled: number
}

/**
 * 一批节点的到期统计。
 *
 * `overdue` 是 `due` 的子集而不是另一类：界面上写「到期 6，其中较早待复习 2」，
 * 不能出现用户把两个数字相加得到 8。
 */
export function dueCounts(nodes: Node[], now: number): DueCounts {
  let due = 0
  let overdue = 0
  let scheduled = 0
  for (const node of nodes) {
    if (!isEnrolledForReview(node)) continue
    if (!isDueForReview(node, now)) {
      scheduled += 1
      continue
    }
    due += 1
    const at = dueAt(node)
    if (at !== null && at < startOfDay(now)) overdue += 1
  }
  return { due, overdue, scheduled }
}

/** 复习列表里每条候选的「为什么是它」。 */
export type ReviewReasonKind = 'overdue' | 'due' | 'first' | 'early' | 'relearn'

export interface ReviewReason {
  kind: ReviewReasonKind
  label: string
}

export function reviewReasonOf(node: Node, now: number): ReviewReason {
  if (isRelearning(node)) return { kind: 'relearn', label: '先补学' }
  if (isFirstReview(node)) return { kind: 'first', label: '首次复习' }
  const at = dueAt(node)
  if (at === null) return { kind: 'due', label: '到期复习' }
  if (at <= now) {
    return at < startOfDay(now)
      ? { kind: 'overdue', label: '到期复习' }
      : { kind: 'due', label: '到期复习' }
  }
  return { kind: 'early', label: '提前复习' }
}

/** 保持率文案；没排过卡时说明「还没复习过」而不是 0%。 */
export function retentionLabel(node: Node, now: number): string {
  const retention = retentionOf(node, now)
  return retention === null ? '还没复习过' : `保持率约 ${Math.round(retention * 100)}%`
}

/**
 * 学习评估是否已过期 —— 语义是「评估之后又有了新的学习内容」。
 *
 * 沿用 6 小时阈值（`isMasteryStale` 的口径），但这里返回原因，因为界面要区分
 * 「又学了新内容」与「评估基于另一版对话」：两者都不是「分数不准」，
 * 而是「这份评估描述的是另一个时刻」。
 */
export type AssessmentStaleness = 'fresh' | 'newStudy' | 'otherVersion'

export function assessmentStaleness(
  meta: AssessmentMeta | undefined,
  node: Node,
  currentPath?: string,
  thresholdMs?: number,
): AssessmentStaleness {
  if (!meta) return 'fresh'
  if (currentPath !== undefined && meta.basedOnPath && meta.basedOnPath !== currentPath) {
    return 'otherVersion'
  }
  const studied = node.lastStudiedAt
  // 没有 evaluatedAt 的历史数据不声称「过期」：不知道依据，就不能编一个时间点来比
  if (studied === undefined || meta.assessedAt === undefined) return 'fresh'
  return studied - meta.assessedAt > (thresholdMs ?? MASTERY_STALE_MS) ? 'newStudy' : 'fresh'
}

/** 掌握状态该显示成什么：没评估过 / AI 评估 / 复习评出来的 / 来源不明的历史数据。 */
export type MasterySourceLabel = '未评估' | 'AI 评估' | '复习反馈' | '历史记录'

export function masterySourceLabel(node: Node): MasterySourceLabel {
  if (!node.mastery) return '未评估'
  const source = node.assessmentMeta?.source
  if (source === 'ai') return 'AI 评估'
  if (source === 'review') return '复习反馈'
  return '历史记录'
}