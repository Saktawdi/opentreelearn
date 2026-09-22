import { describe, expect, it } from 'vitest'
import type { Node } from '@/domain/models'
import { makeNode } from '@/test/fixtures'
import { createReviewCard, scheduleReview } from './fsrs'
import {
  cardHeat,
  dueAt,
  gradeOfScore,
  heatLevel,
  isDue,
  isOverdue,
  isRelearning,
  masteryAfterGrade,
  nextReview,
  previewGrade,
  retentionOf,
  seedReviewCard,
  startOfDay,
} from './schedule'
import { dueCounts } from './enrollment'

const NOW = Date.UTC(2026, 5, 10, 9, 0, 0)

function topic(id: string, partial: Partial<Node> = {}): Node {
  return makeNode({ id, ...partial })
}

function withMastery(node: Node, score: number, updatedAt = NOW): Node {
  return { ...node, mastery: { score, updatedAt } }
}

describe('gradeOfScore', () => {
  it('maps scores to bands at the agreed boundaries', () => {
    expect(gradeOfScore(0)).toBe('again')
    expect(gradeOfScore(39)).toBe('again')
    expect(gradeOfScore(40)).toBe('hard')
    expect(gradeOfScore(59)).toBe('hard')
    expect(gradeOfScore(60)).toBe('good')
    expect(gradeOfScore(84)).toBe('good')
    expect(gradeOfScore(85)).toBe('easy')
    expect(gradeOfScore(100)).toBe('easy')
  })
})

describe('masteryAfterGrade', () => {
  it('moves the score by the band step', () => {
    expect(masteryAfterGrade(60, 'good')).toBe(65)
    expect(masteryAfterGrade(60, 'easy')).toBe(70)
    expect(masteryAfterGrade(60, 'hard')).toBe(55)
  })

  it('presses a forgotten topic back into the relearn band', () => {
    expect(masteryAfterGrade(95, 'again')).toBeLessThanOrEqual(35)
    expect(gradeOfScore(masteryAfterGrade(95, 'again'))).toBe('again')
    // 低分节点不会掉到负数
    expect(masteryAfterGrade(10, 'again')).toBe(0)
  })

  it('never leaves the 0-100 range', () => {
    expect(masteryAfterGrade(100, 'easy')).toBe(100)
    expect(masteryAfterGrade(0, 'again')).toBe(0)
  })
})

describe('review state machine', () => {
  it('seeds a card from the mastery band on first assessment', () => {
    const seeded = seedReviewCard(90, NOW)
    expect(seeded.card.state).toBe('review')
    expect(seeded.card.due).toBeGreaterThan(NOW)
    expect(seeded.lastGrade).toBeUndefined()

    // 低掌握度节点种出来的是「学习步」的卡，对应重新学习
    const weak = seedReviewCard(20, NOW)
    expect(weak.card.state).toBe('learning')
    expect(weak.card.due).toBeGreaterThan(NOW)
  })

  it('advances an existing card instead of resetting it', () => {
    const seeded = seedReviewCard(90, NOW)
    const reviewed = nextReview(seeded, 'good', seeded.card.due)
    expect(reviewed.lastGrade).toBe('good')
    expect(reviewed.card.reps).toBe(seeded.card.reps + 1)
    expect(reviewed.card.due).toBeGreaterThan(seeded.card.due)
  })

  it('builds a card for legacy nodes that only have a mastery score', () => {
    const reviewed = nextReview(undefined, 'good', NOW)
    expect(reviewed.card.reps).toBe(1)
    expect(reviewed.card.due).toBeGreaterThan(NOW)
  })
})

describe('due helpers & dueCounts', () => {
  it('only counts active, assessed, enrolled non-review-center nodes', () => {
    const assessed = withMastery(topic('a'), 70)
    const bare = topic('b')
    const archived = withMastery(topic('c', { status: 'archived' }), 70)
    const center = withMastery(topic('d', { kind: 'review' }), 70)

    const nodes = [assessed, bare, archived, center]
    const stats = dueCounts(nodes, NOW)

    // 从未排过卡的已评估节点视为「立刻要复习」
    expect(isDue(assessed, NOW)).toBe(true)
    expect(isDue(bare, NOW)).toBe(false)
    expect(isDue(archived, NOW)).toBe(false)
    expect(isDue(center, NOW)).toBe(false)
    expect(stats.due).toBe(1)
    expect(stats.overdue).toBe(0)
  })

  it('separates due-today from overdue in dueCounts', () => {
    const today = startOfDay(NOW)
    const dueToday = withMastery(topic('today'), 70)
    dueToday.review = { card: { ...createReviewCard(today), due: today + 60_000 } }
    const overdue = withMastery(topic('late'), 70)
    overdue.review = { card: { ...createReviewCard(today), due: today - 1 } }

    expect(isDue(dueToday, NOW)).toBe(true)
    expect(isOverdue(dueToday, NOW)).toBe(false)
    expect(isDue(overdue, NOW)).toBe(true)
    expect(isOverdue(overdue, NOW)).toBe(true)
    const counts = dueCounts([dueToday, overdue], NOW)
    expect(counts.due).toBe(2)
    expect(counts.overdue).toBe(1)
  })

  it('reports no due date for a node without a card', () => {
    expect(dueAt(withMastery(topic('a'), 70))).toBeNull()
  })
})

describe('previewGrade', () => {
  it('previews next due and score with real scheduler without mutating original', () => {
    const preview = previewGrade(70, undefined, 'good', NOW)
    expect(preview.score).toBe(75)
    expect(preview.due).toBeGreaterThan(NOW)
    expect(preview.scheduledDays).toBeGreaterThanOrEqual(0)
  })
})

describe('retention and heat', () => {
  it('has no retention before the first review', () => {
    expect(retentionOf(withMastery(topic('a'), 70), NOW)).toBeNull()
    expect(heatLevel(null)).toBe('none')
  })

  it('classifies retention into the three heat levels', () => {
    expect(heatLevel(0.9)).toBe('none')
    expect(heatLevel(0.7)).toBe('none')
    expect(heatLevel(0.69)).toBe('warm')
    expect(heatLevel(0.5)).toBe('warm')
    expect(heatLevel(0.49)).toBe('hot')
  })

  it('treats a never-reviewed card as unrated rather than forgotten', () => {
    expect(cardHeat(createReviewCard(NOW), NOW)).toBe('none')
    // 复习过一次之后才按保持率着色
    const reviewed = scheduleReview(createReviewCard(NOW), 'easy', NOW)
    expect(cardHeat(reviewed, NOW)).toBe('none')
  })

  it('decays retention over time for a reviewed card', () => {
    const card = scheduleReview(createReviewCard(NOW), 'easy', NOW)
    const node: Node = { ...withMastery(topic('a'), 90), review: { card } }

    const fresh = retentionOf(node, NOW)!
    const old = retentionOf(node, card.due + 60 * 24 * 60 * 60 * 1000)!

    expect(fresh).toBeGreaterThan(old)
    expect(heatLevel(fresh)).toBe('none')
  })
})

describe('isRelearning', () => {
  it('routes low mastery and learning-state cards to relearning', () => {
    expect(isRelearning(withMastery(topic('low'), 30))).toBe(true)
    expect(isRelearning(withMastery(topic('high'), 70))).toBe(false)
    expect(
      isRelearning({
        ...withMastery(topic('step'), 70),
        review: { card: scheduleReview(createReviewCard(NOW), 'good', NOW) },
      }),
    ).toBe(true)
  })
})