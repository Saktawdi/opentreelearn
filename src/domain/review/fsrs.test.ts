import { describe, expect, it } from 'vitest'
import type { ReviewCard, ReviewGrade } from '@/domain/models'
import { createReviewCard, reviewRetrievability, scheduleReview } from './fsrs'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 0, 1)

function review(card: ReviewCard, grade: ReviewGrade, now: number): ReviewCard {
  return scheduleReview(card, grade, now)
}

/** 反复用 good 复习到卡片进入 Review 状态（默认 1m/10m 学习步）。 */
function graduate(now: number): { card: ReviewCard; at: number } {
  let card = createReviewCard(now)
  let at = now
  for (let i = 0; i < 5 && card.state !== 'review'; i += 1) {
    at += 20 * 60 * 1000
    card = review(card, 'good', at)
  }
  return { card, at }
}

describe('createReviewCard', () => {
  it('creates a new card due at the given moment', () => {
    expect(createReviewCard(NOW)).toEqual({
      due: NOW,
      stability: 0,
      difficulty: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: 'new',
    })
  })
})

describe('scheduleReview', () => {
  it('round-trips our serialized shape through ts-fsrs without losing fields', () => {
    const { card } = graduate(NOW)
    const again = review(card, 'good', card.due)

    // 往返：字段名与单位都必须原样回来（时间戳是 epoch ms，不是 Date）
    expect(again.state).toBe('review')
    expect(Number.isInteger(again.due)).toBe(true)
    expect(again.due).toBeGreaterThan(NOW)
    expect(again.lastReview).toBe(card.due)
    expect(again.reps).toBeGreaterThan(card.reps)
    expect(again.stability).toBeGreaterThan(0)
    expect(again.difficulty).toBeGreaterThan(0)
    // 序列化形状里不允许混进 Date / elapsed_days 这类废弃字段
    expect(again).not.toHaveProperty('elapsed_days')
    expect(again).not.toHaveProperty('elapsedDays')
    expect(Object.values(again).some((value) => value instanceof Date)).toBe(false)
  })

  it('pushes due further out with every successful review', () => {
    const { card, at } = graduate(NOW)
    const first = review(card, 'good', at)
    const second = review(first, 'good', first.due)
    const third = review(second, 'good', second.due)

    expect(first.due).toBeGreaterThan(at)
    expect(second.due).toBeGreaterThan(first.due)
    expect(third.due).toBeGreaterThan(second.due)
    expect(third.scheduledDays).toBeGreaterThanOrEqual(first.scheduledDays)
  })

  it('counts a lapse only when again hits a review-state card', () => {
    const { card, at } = graduate(NOW)
    const before = card.lapses

    const forgotten = review(card, 'again', at)
    expect(forgotten.lapses).toBe(before + 1)
    expect(forgotten.state).toBe('relearning')
    expect(forgotten.due).toBeGreaterThan(at)

    // 学习步里的 again 不是「遗忘」，不该累加 lapses
    const fresh = review(createReviewCard(NOW), 'again', NOW)
    expect(fresh.lapses).toBe(0)
    expect(fresh.state).toBe('learning')
  })

  it('keeps every grade on the timeline ahead of now', () => {
    for (const grade of ['again', 'hard', 'good', 'easy'] as const) {
      const card = review(createReviewCard(NOW), grade, NOW)
      expect(card.due).toBeGreaterThan(NOW)
      expect(card.lastReview).toBe(NOW)
    }
  })
})

describe('reviewRetrievability', () => {
  it('starts at 1 right after a review and decays with time', () => {
    const { card, at } = graduate(NOW)
    const reviewed = review(card, 'good', at)

    const rightAfter = reviewRetrievability(reviewed, at)
    const later = reviewRetrievability(reviewed, reviewed.due)
    const muchLater = reviewRetrievability(reviewed, reviewed.due + 30 * DAY)

    expect(rightAfter).toBeGreaterThan(0.99)
    expect(later).toBeLessThan(rightAfter)
    expect(muchLater).toBeLessThan(later)
  })

  it('reports zero for a card that has never been reviewed', () => {
    expect(reviewRetrievability(createReviewCard(NOW), NOW)).toBe(0)
  })

  it('never throws on a non-new card missing its last review', () => {
    const broken: ReviewCard = { ...createReviewCard(NOW), state: 'review', stability: 10 }
    expect(reviewRetrievability(broken, NOW)).toBe(0)
  })
})