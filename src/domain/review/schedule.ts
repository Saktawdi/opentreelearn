import type { Node, NodeReview, ReviewCard, ReviewGrade } from '@/domain/models'
import { createReviewCard, reviewRetrievability, scheduleReview } from './fsrs'

/**
 * 评分 → 下一个复习状态的纯函数状态机，以及「到期 / 保持率 / 档位」这些
 * 决策口径。所有决策都走**档位**（again / hard / good / easy）：
 *
 * - FSRS 的排期只吃档位；
 * - 掌握度分数只用于展示与排序，不同模型给分分布不可比，拿原始分数当阈值
 *   判据是假精度；
 * - AI 的评分文本（weakPoints）不参与任何调度，只做出题材料。
 */

/** 档位分界：<40 Again / 40-59 Hard / 60-84 Good / ≥85 Easy。 */
export const BAND_AGAIN_MAX = 40
export const BAND_HARD_MAX = 60
export const BAND_GOOD_MAX = 85

/** 「重新学习」的掌握度上界：低于它说明还没掌握到能复习的程度。 */
export const RELEARN_MAX_SCORE = 35

export const GRADE_ACTION_LABEL: Record<ReviewGrade, string> = {
  again: '忘了',
  hard: '吃力',
  good: '记得',
  easy: '太简单',
}

/** 学习快照里的掌握档位措辞（比按钮文案更书面一点）。 */
export const GRADE_BAND_LABEL: Record<ReviewGrade, string> = {
  again: '生疏',
  hard: '不熟',
  good: '掌握',
  easy: '熟练',
}

export function clampScore(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 100)
}

/** 掌握度分档 → FSRS 初始评分；也是「这个节点该复习还是该重新学习」的判据。 */
export function gradeOfScore(score: number): ReviewGrade {
  if (score < BAND_AGAIN_MAX) return 'again'
  if (score < BAND_HARD_MAX) return 'hard'
  if (score < BAND_GOOD_MAX) return 'good'
  return 'easy'
}

/** 每个档位对掌握度的固定步长。 */
const GRADE_SCORE_DELTA: Record<ReviewGrade, number> = {
  again: -25,
  hard: -5,
  good: 5,
  easy: 10,
}

/**
 * 复习评分之后的新掌握度。
 *
 * `again` 额外把分数压回「重新学习」区间 —— 忘了之后还显示 80 分，
 * 用户就不会再信任这个数字；其余档位按固定步长微调。
 */
export function masteryAfterGrade(score: number, grade: ReviewGrade): number {
  const next = clampScore(score + GRADE_SCORE_DELTA[grade])
  return grade === 'again' ? Math.min(next, RELEARN_MAX_SCORE) : next
}

/** 首次掌握度评估（生成学习摘要）时按档位种一张卡，节点从这一刻起进入复习池。 */
export function seedReviewCard(score: number, now: number): NodeReview {
  const grade = gradeOfScore(score)
  return { card: scheduleReview(createReviewCard(now), grade, now) }
}

/** 一次复习评分：推进卡片并记下档位；没有卡片时（历史数据）现建一张再排。 */
export function nextReview(
  review: NodeReview | undefined,
  grade: ReviewGrade,
  now: number,
): NodeReview {
  const card = scheduleReview(review?.card ?? createReviewCard(now), grade, now)
  return { card, lastGrade: grade }
}

/** 进入复习池的条件：活跃、有掌握度、不是复习中心。 */
export function isReviewable(node: Node): boolean {
  return node.status === 'active' && node.kind !== 'review' && Boolean(node.mastery)
}

export function reviewPool(nodes: Node[]): Node[] {
  return nodes.filter(isReviewable)
}

/**
 * 到期时间（epoch ms）。没有排过卡时返回 null —— 「从未排期」和
 * 「到期时间为 0」是两件事，UI 上的措辞不同（重新学习 / 逾期）。
 */
export function dueAt(node: Node): number | null {
  return node.review ? node.review.card.due : null
}

/**
 * 现在是否该复习。
 *
 * 有掌握度但从未排过卡（旧数据、导入的数据）视为「立刻要复习」：
 * 否则这些节点会永远不进复习池，等于被静默丢掉。
 */
export function isDue(node: Node, now: number): boolean {
  if (!isReviewable(node)) return false
  const due = dueAt(node)
  return due === null ? true : due <= now
}

/** 本地零点。复习按「天」组织，逾期判定必须跟用户看到的日历一致。 */
export function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 逾期 = 到期时间早于今天零点；今天之内到期的只是「到期」，不算逾期。 */
export function isOverdue(node: Node, now: number): boolean {
  if (!isDue(node, now)) return false
  const due = dueAt(node)
  return due !== null && due < startOfDay(now)
}

/** 一张卡片的当前保持率（0-1）。 */
export function cardRetention(card: ReviewCard, now: number): number {
  return reviewRetrievability(card, now)
}

/** 节点的当前保持率（0-1）；没有卡片时 null（从未复习过，谈不上保持率）。 */
export function retentionOf(node: Node, now: number): number | null {
  return node.review ? cardRetention(node.review.card, now) : null
}

export interface ReviewDueSummary {
  due: number
  overdue: number
}

/** 一批节点的到期 / 逾期统计（首页「今日复习」与复习中心都用它）。 */
export function reviewStats(nodes: Node[], now: number): ReviewDueSummary {
  let due = 0
  let overdue = 0
  for (const node of nodes) {
    if (!isDue(node, now)) continue
    due += 1
    if (isOverdue(node, now)) overdue += 1
  }
  return { due, overdue }
}

/** 保持率热力档位：默认 70% 琥珀、50% 红。 */
export const HEAT_WARM_THRESHOLD = 0.7
export const HEAT_HOT_THRESHOLD = 0.5

export type HeatLevel = 'none' | 'warm' | 'hot'

export function heatLevel(retention: number | null): HeatLevel {
  if (retention === null) return 'none'
  if (retention < HEAT_HOT_THRESHOLD) return 'hot'
  if (retention < HEAT_WARM_THRESHOLD) return 'warm'
  return 'none'
}

/**
 * 卡片的展示热力：**从没复习过的卡不算热**。
 *
 * 新卡的保持率在公式上就是 0，直接映射会得到一片红 —— 但那是「还没开始」，
 * 不是「快忘了」，两者在界面上必须区分开。
 */
export function cardHeat(card: ReviewCard, now: number): HeatLevel {
  if (card.lastReview === undefined) return 'none'
  return heatLevel(reviewRetrievability(card, now))
}

/**
 * 这个节点是不是「重新学习」而不是「复习」：低掌握度，或 FSRS 已处在
 * （重）学习步。两者都意味着还没到能靠回忆巩固的程度。
 */
export function isRelearning(node: Node): boolean {
  const score = node.mastery?.score
  if (score !== undefined && gradeOfScore(score) === 'again') return true
  const state = node.review?.card.state
  return state === 'learning' || state === 'relearning'
}