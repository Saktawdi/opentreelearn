import { describe, expect, it } from 'vitest'
import type { Node } from '@/domain/models'
import { makeNode } from '@/test/fixtures'
import { buildStudyDigest, renderStudyDigest, studiedDaysAgo } from './digest'
import { createReviewCard } from './fsrs'

const NOW = Date.UTC(2026, 5, 10, 9, 0, 0)
const DAY = 24 * 60 * 60 * 1000

function topic(id: string, partial: Partial<Node> = {}): Node {
  return makeNode({ id, ...partial })
}

describe('buildStudyDigest', () => {
  it('describes an empty tree with a single sentence', () => {
    const digest = buildStudyDigest([], { now: NOW })

    expect(digest).toEqual({ entries: [], omitted: 0, total: 0 })
    expect(renderStudyDigest(digest)).toBe('（这个项目还没有学习记录）')
  })

  it('lists never-studied nodes without inventing a score', () => {
    const nodes = [topic('a'), topic('b', { parentId: 'a' })]
    const digest = buildStudyDigest(nodes, { now: NOW })

    expect(digest.total).toBe(2)
    expect(digest.entries[0]).toMatchObject({
      title: 'a',
      depth: 0,
      band: null,
      studiedDaysAgo: null,
      retention: null,
      due: false,
      relearn: false,
    })
    // 子主题缩进一层，树结构要看得出来
    expect(digest.entries[1].depth).toBe(1)
    expect(renderStudyDigest(digest)).toContain('- 《a》 · 未评估 · 尚未学习 · 保持率未知')
    expect(renderStudyDigest(digest)).toContain('  - 《b》')
  })

  it('renders band, study age, retention and weak points', () => {
    const node: Node = {
      ...topic('a'),
      mastery: { score: 72, updatedAt: NOW, weakPoints: ['边界条件', '符号'] },
      lastStudiedAt: NOW - 3 * DAY,
      review: { card: { ...createReviewCard(NOW), due: NOW - DAY, stability: 30, state: 'review', lastReview: NOW - DAY } },
    }

    const text = renderStudyDigest(buildStudyDigest([node], { now: NOW }))

    expect(text).toContain('档位 good')
    expect(text).toContain('3 天前学习')
    expect(text).toMatch(/保持率 \d+%/)
    expect(text).toContain('薄弱：边界条件、符号')
    expect(text).toContain('已到期')
  })

  it('excludes the review center and archived nodes', () => {
    const center = topic('center', { kind: 'review' })
    const archived = topic('archived', { status: 'archived' })
    const digest = buildStudyDigest([center, archived, topic('a')], { now: NOW })

    expect(digest.entries.map((entry) => entry.title)).toEqual(['a'])
  })

  it('never drops an active node, even when its parent is archived or missing', () => {
    // 父节点归档 ⇒ 活跃子节点变成孤儿，但仍要出现在快照里（否则它的掌握度
    // 与排期在复习中心里凭空消失）
    const archivedParent = topic('parent', { status: 'archived' })
    const child = topic('child', { parentId: 'parent' })
    const grandChild = topic('grand', { parentId: 'child' })
    const orphan = topic('orphan', { parentId: 'ghost' })

    const digest = buildStudyDigest([archivedParent, child, grandChild, orphan], { now: NOW })

    expect(digest.entries.map((entry) => entry.nodeId).sort()).toEqual([
      'child',
      'grand',
      'orphan',
    ])
  })

  it('never drops an active node trapped in a parent/child cycle', () => {
    const nodes = [topic('a', { parentId: 'b' }), topic('b', { parentId: 'a' })]
    const digest = buildStudyDigest(nodes, { now: NOW })

    // 环从任何根都走不到：仍要平铺出来，且不能死循环
    expect(digest.entries.map((entry) => entry.nodeId).sort()).toEqual(['a', 'b'])
  })

  it('keeps the most urgent entries when the tree is huge, and reports the rest', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => topic(`n${index}`))
    // 只有最后一条到期：超限时它必须留下
    const due = nodes[5]
    due.mastery = { score: 70, updatedAt: NOW }
    due.review = { card: { ...createReviewCard(NOW), due: NOW - DAY } }

    const digest = buildStudyDigest(nodes, { now: NOW, limit: 2 })

    expect(digest.entries).toHaveLength(2)
    expect(digest.entries.map((entry) => entry.nodeId)).toContain('n5')
    expect(digest.omitted).toBe(4)
    expect(renderStudyDigest(digest)).toContain('（还有 4 个主题未列出）')
  })
})

describe('studiedDaysAgo', () => {
  it('measures whole days from the local midnight', () => {
    expect(studiedDaysAgo({ ...topic('a'), lastStudiedAt: NOW - DAY }, NOW)).toBe(1)
    expect(studiedDaysAgo({ ...topic('b'), lastStudiedAt: NOW }, NOW)).toBe(0)
    expect(studiedDaysAgo(topic('c'), NOW)).toBeNull()
  })
})