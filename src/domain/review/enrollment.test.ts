import { describe, expect, it } from 'vitest'
import type { Node, ReviewCard } from '@/domain/models'
import { makeNode } from '@/test/fixtures'
import {
  assessmentStaleness,
  dueCounts,
  enrollmentOf,
  enrollmentStateOf,
  isDueForReview,
  isEarlyReview,
  isEnrolledForReview,
  isFirstReview,
  masterySourceLabel,
  reviewReasonOf,
} from './enrollment'

const NOW = 1700000000000
const DAY = 24 * 60 * 60 * 1000

function fakeCard(due: number): ReviewCard {
  return {
    due,
    stability: 5,
    difficulty: 5,
    scheduledDays: 1,
    learningSteps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
  }
}

function sampleNode(partial: Partial<Node> = {}): Node {
  return {
    ...makeNode({ id: 'n1' }),
    ...partial,
  }
}

describe('review enrollment domain', () => {
  it('correctly derives enrollment status and fallback for legacy nodes', () => {
    // 显式开关优先
    expect(enrollmentOf(sampleNode({ reviewEnrollment: 'enabled' }))).toBe('enabled')
    expect(enrollmentOf(sampleNode({ reviewEnrollment: 'disabled' }))).toBe('disabled')

    // 兼容老数据：有掌握度但无开关 => enabled
    const legacyAssessed = sampleNode({ mastery: { score: 75, updatedAt: NOW } })
    expect(enrollmentOf(legacyAssessed)).toBe('enabled')
    expect(enrollmentStateOf(legacyAssessed)).toBe('enrolled')

    // 未评估 => unassessed
    const bare = sampleNode()
    expect(enrollmentOf(bare)).toBe('disabled')
    expect(enrollmentStateOf(bare)).toBe('unassessed')

    // 已评估但显式未加入 => notEnrolled
    const unenrolled = sampleNode({
      mastery: { score: 75, updatedAt: NOW },
      reviewEnrollment: 'disabled',
    })
    expect(enrollmentStateOf(unenrolled)).toBe('notEnrolled')
    expect(isEnrolledForReview(unenrolled)).toBe(false)
  })

  it('identifies first review for assessed nodes without a card', () => {
    const firstReviewNode = sampleNode({
      mastery: { score: 70, updatedAt: NOW },
      reviewEnrollment: 'enabled',
    })
    expect(isFirstReview(firstReviewNode)).toBe(true)
    expect(isDueForReview(firstReviewNode, NOW)).toBe(true)
    expect(reviewReasonOf(firstReviewNode, NOW).kind).toBe('first')
    expect(reviewReasonOf(firstReviewNode, NOW).label).toBe('首次复习')
  })

  it('computes accurate dueCounts without counting overdue twice', () => {
    const today = NOW
    const overdueNode = sampleNode({
      id: 'overdue',
      mastery: { score: 70, updatedAt: NOW },
      reviewEnrollment: 'enabled',
      review: { card: fakeCard(today - 2 * DAY) },
    })
    const dueTodayNode = sampleNode({
      id: 'dueToday',
      mastery: { score: 70, updatedAt: NOW },
      reviewEnrollment: 'enabled',
      review: { card: fakeCard(today) },
    })
    const futureNode = sampleNode({
      id: 'future',
      mastery: { score: 70, updatedAt: NOW },
      reviewEnrollment: 'enabled',
      review: { card: fakeCard(today + 5 * DAY) },
    })
    const unenrolledNode = sampleNode({
      id: 'unenrolled',
      mastery: { score: 70, updatedAt: NOW },
      reviewEnrollment: 'disabled',
      review: { card: fakeCard(today - DAY) },
    })

    const counts = dueCounts(
      [overdueNode, dueTodayNode, futureNode, unenrolledNode],
      today,
    )
    expect(counts.due).toBe(2)
    expect(counts.overdue).toBe(1)
    expect(counts.scheduled).toBe(1)
    expect(isEarlyReview(futureNode, today)).toBe(true)
  })

  it('accurately evaluates assessment staleness and sources', () => {
    const freshNode = sampleNode({
      mastery: { score: 80, updatedAt: NOW },
      lastStudiedAt: NOW + 1000,
      assessmentMeta: {
        assessedAt: NOW,
        basedOnStudiedAt: NOW,
        source: 'ai',
      },
    })
    expect(assessmentStaleness(freshNode.assessmentMeta, freshNode)).toBe('fresh')
    expect(masterySourceLabel(freshNode)).toBe('AI 评估')

    const newStudyNode = sampleNode({
      mastery: { score: 80, updatedAt: NOW },
      lastStudiedAt: NOW + 10 * 60 * 60 * 1000,
      assessmentMeta: {
        assessedAt: NOW,
        basedOnStudiedAt: NOW,
        source: 'ai',
      },
    })
    expect(assessmentStaleness(newStudyNode.assessmentMeta, newStudyNode)).toBe('newStudy')

    const otherVersionNode = sampleNode({
      mastery: { score: 80, updatedAt: NOW },
      lastStudiedAt: NOW,
      assessmentMeta: {
        assessedAt: NOW,
        basedOnPath: 'path-version-old',
        source: 'review',
      },
    })
    expect(
      assessmentStaleness(otherVersionNode.assessmentMeta, otherVersionNode, 'path-version-new'),
    ).toBe('otherVersion')
    expect(masterySourceLabel(otherVersionNode)).toBe('复习反馈')
  })
})