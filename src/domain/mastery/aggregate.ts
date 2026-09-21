import type { Id, MasterySnapshot, Node } from '@/domain/models'
import { buildTreeIndex } from '@/domain/tree/tree'

/**
 * 掌握度的子树聚合（纯函数）。
 *
 * 为什么父节点不存聚合值：存了就要在每次子节点变化时级联回写，还要处理
 * 多端合并、拖拽换父、归档等一堆边界；实时聚合只依赖「当前树 + 各节点自己的
 * 分数」，永远不会不一致。代价是每次渲染算一遍，而它只是几次加法和除法。
 *
 * 两条明确的排除规则：
 * - **复习中心（kind: 'review'）整棵子树都不参与**：它是元数据节点，没有学习内容；
 * - 归档节点不参与：归档等于从学习地图上拿掉，不该再影响题目的掌握度。
 */

/** 掌握度快照的保质期：摘要快照之后又学了超过这个时长，分数就不再代表现状。 */
export const MASTERY_STALE_MS = 6 * 60 * 60 * 1000

export interface MasteryAggregate {
  /** 子树（含自身）里有掌握度的节点均值，四舍五入到整数；一个都没有时为 null */
  score: number | null
  /** 有掌握度的节点数 */
  learned: number
  /** 参与统计的节点数（已排除复习中心与归档节点） */
  total: number
  /** learned / total；total 为 0 时是 0 */
  coverage: number
}

const EMPTY_STAT: MasteryAggregate = { score: null, learned: 0, total: 0, coverage: 0 }

/** 参与聚合的节点：活跃、不是复习中心。 */
function isCounted(node: Node): boolean {
  return node.status === 'active' && node.kind !== 'review'
}

interface StatAccumulator {
  total: number
  learned: number
  sum: number
}

function addNode(acc: StatAccumulator, node: Node): void {
  if (!isCounted(node)) return
  acc.total += 1
  if (node.mastery) {
    acc.learned += 1
    acc.sum += node.mastery.score
  }
}

function toAggregate(acc: StatAccumulator): MasteryAggregate {
  return {
    score: acc.learned > 0 ? Math.round(acc.sum / acc.learned) : null,
    learned: acc.learned,
    total: acc.total,
    coverage: acc.total > 0 ? acc.learned / acc.total : 0,
  }
}

/**
 * 一次遍历算出每个节点的子树聚合，供画布一次性取用（避免每张卡各算一遍）。
 *
 * 环（坏数据的父子互指）里不再继续下钻：宁可少算几个节点，也不能让渲染死循环。
 */
export function masteryIndex(nodes: Node[]): Map<Id, MasteryAggregate> {
  const index = buildTreeIndex(nodes)
  const memo = new Map<Id, StatAccumulator>()
  const path = new Set<Id>()

  function visit(node: Node): StatAccumulator {
    const cached = memo.get(node.id)
    if (cached) return cached
    if (path.has(node.id)) return { total: 0, learned: 0, sum: 0 }
    // 复习中心自成一棵树：它自己与它下面的东西都不是学习内容，整棵不参与聚合
    if (node.kind === 'review') {
      const empty: StatAccumulator = { total: 0, learned: 0, sum: 0 }
      memo.set(node.id, empty)
      return empty
    }

    path.add(node.id)
    const acc: StatAccumulator = { total: 0, learned: 0, sum: 0 }
    addNode(acc, node)
    for (const child of index.children.get(node.id) ?? []) {
      const childStat = visit(child)
      acc.total += childStat.total
      acc.learned += childStat.learned
      acc.sum += childStat.sum
    }
    path.delete(node.id)

    memo.set(node.id, acc)
    return acc
  }

  for (const node of nodes) visit(node)

  const result = new Map<Id, MasteryAggregate>()
  for (const [id, acc] of memo) result.set(id, toAggregate(acc))
  return result
}

/** 单个节点的子树聚合；节点不在列表里（已删除）时返回空统计。 */
export function aggregateMastery(nodes: Node[], nodeId: Id): MasteryAggregate {
  return masteryIndex(nodes).get(nodeId) ?? EMPTY_STAT
}

/**
 * 掌握度是否已过期：快照之后又学习（或复习）了足够久，分数就不再代表现状。
 *
 * 阈值刻意不是 0 —— 生成摘要后顺手再问一句也会让 `lastStudiedAt` 变新，
 * 那点时间差不足以让分数失真，标记反而会一直亮着让人不再当回事。
 */
export function isMasteryStale(
  mastery: MasterySnapshot | undefined,
  lastStudiedAt: number | undefined,
  thresholdMs = MASTERY_STALE_MS,
): boolean {
  if (!mastery || lastStudiedAt === undefined) return false
  return lastStudiedAt - mastery.updatedAt > thresholdMs
}