import { describe, expect, it } from 'vitest'
import type { Node, ReviewCard } from '@/domain/models'
import { makeNode } from '@/test/fixtures'
import { createReviewCard } from './fsrs'
import {
  buildReviewQueue,
  defaultSelection,
  earlyReviewCandidates,
  MAX_BATCH_SIZE,
  pickBatch,
} from './queue'

const NOW = Date.UTC(2026, 5, 10, 9, 0, 0)
const DAY = 24 * 60 * 60 * 1000

interface ScheduledOptions {
  parentId?: string | null
  score?: number
  due?: number
  card?: ReviewCard
  enrollment?: 'enabled' | 'disabled'
}

/** 造一个已排期的节点：掌握度 + 一张卡，`due` 默认已过期。 */
function scheduled(id: string, options: ScheduledOptions = {}): Node {
  const card = options.card ?? createReviewCard(NOW)
  const node = makeNode({ id, parentId: options.parentId ?? null })
  return {
    ...node,
    mastery: { score: options.score ?? 70, updatedAt: NOW },
    review: { card: { ...card, due: options.due ?? NOW - 1000 } },
    ...(options.enrollment ? { reviewEnrollment: options.enrollment } : {}),
  }
}

/** 稳定度越高，同样时间后的保持率越高。 */
function reviewStateCard(stability: number): ReviewCard {
  return {
    due: NOW,
    stability,
    difficulty: 5,
    scheduledDays: 1,
    learningSteps: 0,
    reps: 3,
    lapses: 0,
    state: 'review',
    lastReview: NOW - DAY,
  }
}

describe('buildReviewQueue', () => {
  it('only queues due, assessed, active topic nodes enrolled in review', () => {
    const archived = scheduled('archived')
    archived.status = 'archived'
    const center = scheduled('center')
    center.kind = 'review'
    const unenrolled = scheduled('unenrolled', { enrollment: 'disabled' })

    const nodes = [
      scheduled('due'),
      makeNode({ id: 'unassessed' }),
      archived,
      center,
      unenrolled,
      scheduled('future', { due: NOW + DAY }),
    ]

    expect(buildReviewQueue(nodes, NOW).map((item) => item.nodeId)).toEqual(['due'])
  })

  it('sorts by retention ascending (most forgotten first)', () => {
    const forgotten = scheduled('forgotten', { card: reviewStateCard(1) })
    const solid = scheduled('solid', { card: reviewStateCard(100) })

    const queue = buildReviewQueue([solid, forgotten], NOW)

    expect(queue.map((item) => item.nodeId)).toEqual(['forgotten', 'solid'])
    expect(queue[0].retention).toBeLessThan(queue[1].retention as number)
  })

  it('interleaves so two consecutive items never share a parent', () => {
    const nodes = [
      scheduled('a', { parentId: 'p1', card: reviewStateCard(1) }),
      scheduled('b', { parentId: 'p1', card: reviewStateCard(2) }),
      scheduled('c', { parentId: 'p2', card: reviewStateCard(50) }),
      scheduled('d', { parentId: 'p3', card: reviewStateCard(60) }),
    ]

    const ids = buildReviewQueue(nodes, NOW).map((item) => item.nodeId)
    const parents = new Map(nodes.map((node) => [node.id, node.parentId]))

    for (let i = 1; i < ids.length; i += 1) {
      expect(parents.get(ids[i])).not.toBe(parents.get(ids[i - 1]))
    }
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not truncate candidates in the queue but pickBatch limits to MAX_BATCH_SIZE', () => {
    const nodes = Array.from({ length: 28 }, (_, index) =>
      scheduled(`n${index}`),
    )
    const queue = buildReviewQueue(nodes, NOW)
    expect(queue).toHaveLength(28)

    const batch = pickBatch(queue, 30)
    expect(batch).toHaveLength(MAX_BATCH_SIZE)

    const def = defaultSelection(queue)
    expect(def).toHaveLength(3)
  })

  it('marks low-mastery and learning-state nodes as relearn', () => {
    const weak = scheduled('weak', { score: 30 })
    const strong = scheduled('strong', { score: 80, card: reviewStateCard(50) })
    const learning = scheduled('learning', {
      score: 80,
      card: { ...createReviewCard(NOW), state: 'learning', lastReview: NOW - DAY },
    })

    const modes = new Map(
      buildReviewQueue([weak, strong, learning], NOW).map((item) => [item.nodeId, item.mode]),
    )

    expect(modes.get('weak')).toBe('relearn')
    expect(modes.get('learning')).toBe('relearn')
    expect(modes.get('strong')).toBe('review')
  })
})

describe('earlyReviewCandidates', () => {
  it('returns enrolled nodes that are not yet due', () => {
    const dueNode = scheduled('due', { due: NOW - 1000 })
    const futureNode = scheduled('future', { due: NOW + 10 * DAY, enrollment: 'enabled' })
    const notEnrolled = scheduled('not-enrolled', { due: NOW + 10 * DAY, enrollment: 'disabled' })

    const result = earlyReviewCandidates([dueNode, futureNode, notEnrolled], NOW)
    expect(result.map((i) => i.nodeId)).toEqual(['future'])
  })
})