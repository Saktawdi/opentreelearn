import { describe, expect, it } from 'vitest'
import type { Node } from '@/domain/models'
import { makeNode } from '@/test/fixtures'
import { aggregateMastery, isMasteryStale, masteryIndex, MASTERY_STALE_MS } from './aggregate'

function withMastery(node: Node, score: number): Node {
  return { ...node, mastery: { score, updatedAt: 100 } }
}

describe('masteryIndex', () => {
  it('averages the subtree and reports coverage', () => {
    const root = withMastery(makeNode({ id: 'root' }), 80)
    const childA = withMastery(makeNode({ id: 'a', parentId: 'root' }), 60)
    const childB = makeNode({ id: 'b', parentId: 'root' })

    const index = masteryIndex([root, childA, childB])

    expect(index.get('root')).toEqual({ score: 70, learned: 2, total: 3, coverage: 2 / 3 })
    expect(index.get('a')).toEqual({ score: 60, learned: 1, total: 1, coverage: 1 })
    // 没有掌握度的节点不参与均值（不是 0 分），但会计入覆盖率的分母
    expect(index.get('b')).toEqual({ score: null, learned: 0, total: 1, coverage: 0 })
  })

  it('counts the whole subtree, not only direct children', () => {
    const root = withMastery(makeNode({ id: 'root' }), 50)
    const child = makeNode({ id: 'child', parentId: 'root' })
    const grandChild = withMastery(makeNode({ id: 'grand', parentId: 'child' }), 100)

    expect(aggregateMastery([root, child, grandChild], 'root')).toEqual({
      score: 75,
      learned: 2,
      total: 3,
      coverage: 2 / 3,
    })
  })

  it('skips the review center and its subtree entirely', () => {
    const root = withMastery(makeNode({ id: 'root' }), 80)
    const child = withMastery(makeNode({ id: 'child', parentId: 'root' }), 20)
    const center = makeNode({ id: 'review', kind: 'review' })
    const centerChild = withMastery(makeNode({ id: 'rc', parentId: 'review' }), 0)

    const index = masteryIndex([root, child, center, centerChild])

    expect(index.get('root')).toEqual({ score: 50, learned: 2, total: 2, coverage: 1 })
    // 复习中心自己不参与聚合，哪怕它挂了掌握度
    expect(index.get('review')).toEqual({ score: null, learned: 0, total: 0, coverage: 0 })
  })

  it('ignores archived nodes', () => {
    const root = withMastery(makeNode({ id: 'root' }), 90)
    const archived = withMastery(
      makeNode({ id: 'gone', parentId: 'root', status: 'archived' }),
      10,
    )

    expect(aggregateMastery([root, archived], 'root')).toEqual({
      score: 90,
      learned: 1,
      total: 1,
      coverage: 1,
    })
  })

  it('returns an empty aggregate for a missing node', () => {
    expect(aggregateMastery([makeNode({ id: 'n1' })], 'nope')).toEqual({
      score: null,
      learned: 0,
      total: 0,
      coverage: 0,
    })
  })

  it('survives a parent/child cycle without looping forever', () => {
    const a = withMastery(makeNode({ id: 'a', parentId: 'b' }), 40)
    const b = withMastery(makeNode({ id: 'b', parentId: 'a' }), 60)

    const index = masteryIndex([a, b])

    // 环上不再继续下钻，只保证结果是有限数值而不是死循环 / NaN
    for (const stat of index.values()) {
      expect(stat.score).not.toBeNull()
      expect(Number.isFinite(stat.score!)).toBe(true)
      expect(stat.learned).toBeGreaterThan(0)
    }
  })
})

describe('isMasteryStale', () => {
  const mastery = { score: 80, updatedAt: 1_000 }

  it('marks the snapshot stale only after the threshold', () => {
    expect(isMasteryStale(mastery, 1_000 + MASTERY_STALE_MS)).toBe(false)
    expect(isMasteryStale(mastery, 1_000 + MASTERY_STALE_MS + 1)).toBe(true)
  })

  it('needs both a snapshot and a study time', () => {
    expect(isMasteryStale(undefined, 10_000)).toBe(false)
    expect(isMasteryStale(mastery, undefined)).toBe(false)
    // 先有分数、后学习 ⇒ 过期；先学习、后打分 ⇒ 新鲜
    expect(isMasteryStale(mastery, 999)).toBe(false)
  })
})