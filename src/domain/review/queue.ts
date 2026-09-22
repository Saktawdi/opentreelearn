import type { Id, Node } from '@/domain/models'
import { isDueForReview, isEnrolledForReview, isFirstReview } from './enrollment'
import { dueAt, isRelearning, retentionOf } from './schedule'

/**
 * 复习候选与本次批次（纯函数）。
 *
 * 两个概念必须分开，否则界面上「今天有 6 个到期」和「这次只复习 3 个」永远
 * 讲不清楚：
 * - **候选集合**：所有已加入计划且到期的主题，不截断 —— 用户随时看得到全貌；
 * - **本次批次**：用户勾选后真正进入会话的那些，上限 `MAX_BATCH_SIZE`。
 *
 * 旧实现的 `DAILY_REVIEW_CAP` 名字像「每天最多 20 个」，行为却是「每次会话
 * 截断 20 条」，还顺带让第 21 个主题在界面上彻底消失。
 *
 * 排序不是随手排的，两条教学法约束：
 * 1. **保持率最低的优先** —— 最接近遗忘的先救；
 * 2. **不与上一题同父** —— 交错（interleaving）比连续复习同一主题记得更牢，
 *    也让会话不至于连着三次同一个分支。
 */

/** 单批最多选多少个主题；这是「一次会话」的上限，不是每日上限。 */
export const MAX_BATCH_SIZE = 20

/** 默认推荐多少个：够形成一次完整复习，又不至于让人望而却步。 */
export const DEFAULT_BATCH_SIZE = 3

export type ReviewMode = 'review' | 'relearn'

export interface ReviewQueueItem {
  nodeId: Id
  /** 低掌握度 / FSRS 处在（重）学习步 ⇒ 重新学习，而不是复习 */
  mode: ReviewMode
  /** 到期时间；从未排过卡时为 null */
  dueAt: number | null
  /** 当前保持率（0-1）；从未复习过时为 null */
  retention: number | null
  /** 有掌握度但从未排过卡：界面写「首次复习」，不能算逾期 */
  firstReview: boolean
}

/** 排序键：保持率升序（null 视为 0，最先处理），再按到期时间、id 兜底保证稳定。 */
function rankOf(item: ReviewQueueItem): number {
  return item.retention ?? 0
}

function compareItems(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const byRetention = rankOf(a) - rankOf(b)
  if (byRetention !== 0) return byRetention
  const byDue = (a.dueAt ?? 0) - (b.dueAt ?? 0)
  if (byDue !== 0) return byDue
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
}

/**
 * 交错：每次从「与上一题不同父」的组里取当前最紧急的一条；
 * 剩下的全是同父时（无路可退）按紧急度直接取，绝不空转。
 */
function interleaveByParent(
  items: ReviewQueueItem[],
  parentKeyOf: (item: ReviewQueueItem) => string,
): ReviewQueueItem[] {
  const groups = new Map<string, ReviewQueueItem[]>()
  for (const item of items) {
    const key = parentKeyOf(item)
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(item)
    } else {
      groups.set(key, [item])
    }
  }

  const result: ReviewQueueItem[] = []
  let lastKey: string | null = null

  while (result.length < items.length) {
    let pickedKey: string | null = null
    for (const [key, bucket] of groups) {
      if (bucket.length === 0 || key === lastKey) continue
      if (pickedKey === null || compareItems(bucket[0], groups.get(pickedKey)![0]) < 0) {
        pickedKey = key
      }
    }
    if (pickedKey === null) {
      for (const [key, bucket] of groups) {
        if (bucket.length > 0) {
          pickedKey = key
          break
        }
      }
    }
    if (pickedKey === null) break

    const bucket = groups.get(pickedKey)!
    const item = bucket.shift()!
    result.push(item)
    lastKey = pickedKey
  }

  return result
}

function toItem(node: Node, now: number): ReviewQueueItem {
  return {
    nodeId: node.id,
    mode: isRelearning(node) ? 'relearn' : 'review',
    dueAt: dueAt(node),
    retention: retentionOf(node, now),
    firstReview: isFirstReview(node),
  }
}

function sortInterleaved(items: ReviewQueueItem[], parentOf: Map<Id, string>): ReviewQueueItem[] {
  return interleaveByParent(
    [...items].sort(compareItems),
    (item) => parentOf.get(item.nodeId) ?? '',
  )
}

/**
 * 全部到期候选，按保持率 + 交错排序，**不截断**。
 *
 * 归档节点、复习中心、没有掌握度的节点、未加入计划的节点都不进队列。
 */
export function buildReviewQueue(nodes: Node[], now: number): ReviewQueueItem[] {
  const due = nodes.filter((node) => isDueForReview(node, now))
  const parentOf = new Map(due.map((node) => [node.id, node.parentId ?? '']))
  return sortInterleaved(due.map((node) => toItem(node, now)), parentOf)
}

/**
 * 提前复习候选：已加入计划、但还没到期的主题。
 *
 * 刻意不混进默认推荐 —— 「今天到期」和「可以提前复习」是两种不同的建议，
 * 混在一起会让用户以为积压了很多。
 */
export function earlyReviewCandidates(nodes: Node[], now: number): ReviewQueueItem[] {
  const early = nodes.filter(
    (node) => isEnrolledForReview(node) && !isDueForReview(node, now),
  )
  const parentOf = new Map(early.map((node) => [node.id, node.parentId ?? '']))
  return sortInterleaved(early.map((node) => toItem(node, now)), parentOf)
}

/** 用户勾选的候选顺序就是进入顺序：只做去重与上限裁剪，不重排。 */
export function pickBatch(items: ReviewQueueItem[], size: number): ReviewQueueItem[] {
  const limit = Math.min(Math.max(Math.floor(size), 0), MAX_BATCH_SIZE)
  const seen = new Set<Id>()
  const picked: ReviewQueueItem[] = []
  for (const item of items) {
    if (picked.length >= limit) break
    if (seen.has(item.nodeId)) continue
    seen.add(item.nodeId)
    picked.push(item)
  }
  return picked
}

/**
 * 默认推荐：排序后的前 `min(DEFAULT_BATCH_SIZE, 候选数)` 个。
 *
 * 返回的是**推荐结果**而不是全量队列的前缀 —— 用户可以在概览里改选，
 * 但默认值必须一眼看得出「先做哪几个」。
 */
export function defaultSelection(
  items: ReviewQueueItem[],
  size = DEFAULT_BATCH_SIZE,
): ReviewQueueItem[] {
  return pickBatch(items, Math.min(size, MAX_BATCH_SIZE))
}