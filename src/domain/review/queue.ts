import type { Id, Node } from '@/domain/models'
import { dueAt, isDue, isRelearning, retentionOf, reviewPool } from './schedule'

/**
 * 复习会话队列（纯函数）。
 *
 * 排序不是随手排的，两条教学法约束：
 * 1. **保持率最低的优先** —— 最接近遗忘的先救；
 * 2. **不与上一题同父** —— 交错（interleaving）比连续复习同一主题记得更牢，
 *    也让会话不至于连着三次同一个分支。
 */

/** 队列封顶 20/天：一次性砸 80 个到期节点，用户会直接关掉这个功能。 */
export const DAILY_REVIEW_CAP = 20

export type ReviewMode = 'review' | 'relearn'

export interface ReviewQueueItem {
  nodeId: Id
  /** 低掌握度 / FSRS 处在（重）学习步 ⇒ 重新学习，而不是复习 */
  mode: ReviewMode
  /** 到期时间；从未排过卡时为 null */
  dueAt: number | null
  /** 当前保持率（0-1）；从未复习过时为 null */
  retention: number | null
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

/**
 * 今天的复习队列：只取到期节点，按保持率 + 交错排序，封顶 `cap` 条。
 * 归档节点、复习中心、没有掌握度的节点都不进队列。
 */
export function buildReviewQueue(
  nodes: Node[],
  now: number,
  cap = DAILY_REVIEW_CAP,
): ReviewQueueItem[] {
  const due = reviewPool(nodes).filter((node) => isDue(node, now))
  const parentOf = new Map(due.map((node) => [node.id, node.parentId ?? '']))

  const items: ReviewQueueItem[] = due
    .map((node): ReviewQueueItem => ({
      nodeId: node.id,
      mode: isRelearning(node) ? 'relearn' : 'review',
      dueAt: dueAt(node),
      retention: retentionOf(node, now),
    }))
    .sort(compareItems)

  return interleaveByParent(items, (item) => parentOf.get(item.nodeId) ?? '').slice(0, cap)
}