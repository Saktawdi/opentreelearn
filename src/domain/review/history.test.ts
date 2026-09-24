import { describe, expect, it } from 'vitest'
import type { Id } from '@/domain/models'
import type { ReviewItemResult, ReviewSessionItem, ReviewSessionRecord } from './session'
import { reviewHistoryForNode } from './history'

let seq = 0

function confirmedItem(nodeId: string, grade: 'again' | 'hard' | 'good' | 'easy', at: number, weakPoints?: string[]): ReviewSessionItem {
  seq += 1
  const result: ReviewItemResult = {
    operationId: `op${seq}` as Id,
    confirmedAt: at,
    grade,
    baseUpdatedAt: at - 1000,
    baseCard: null,
    masteryAfter: { score: 60, ...(weakPoints ? { weakPoints } : {}), updatedAt: at },
    cardAfter: {
      card: {
        due: at + 86400000,
        stability: 1,
        difficulty: 5,
        scheduledDays: 1,
        learningSteps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
      },
    },
  }
  return {
    itemId: `i${seq}` as Id,
    nodeId: nodeId as Id,
    title: '主题',
    mode: 'review',
    phase: 'done',
    messages: [],
    result,
    updatedAt: at,
  }
}

function skippedItem(nodeId: string, at: number, reason = '用户跳过'): ReviewSessionItem {
  seq += 1
  return {
    itemId: `i${seq}` as Id,
    nodeId: nodeId as Id,
    title: '主题',
    mode: 'review',
    phase: 'skipped',
    messages: [],
    skipReason: reason,
    updatedAt: at,
  }
}

function session(items: ReviewSessionItem[]): ReviewSessionRecord {
  seq += 1
  return {
    id: `s${seq}` as Id,
    schemaVersion: 1,
    projectId: 'p1' as Id,
    status: 'completed',
    version: 1,
    origin: 'overview',
    items,
    cursor: items.length,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('reviewHistoryForNode', () => {
  it('只取该节点的行，按时间倒序', () => {
    const sessions = [
      session([confirmedItem('n1', 'good', 100), confirmedItem('n2', 'easy', 200)]),
      session([confirmedItem('n1', 'again', 300, ['边界条件'])]),
    ]
    const history = reviewHistoryForNode(sessions, 'n1' as Id)
    expect(history.total).toBe(2)
    expect(history.rows.map((row) => row.grade)).toEqual(['again', 'good'])
    expect(history.rows[0].weakPoints).toEqual(['边界条件'])
  })

  it('跳过的项如实保留为 skipped 行', () => {
    const sessions = [session([skippedItem('n1', 150, '这次先跳过')])]
    const history = reviewHistoryForNode(sessions, 'n1' as Id)
    expect(history.rows[0].skipped).toBe('这次先跳过')
    expect(history.rows[0].grade).toBeUndefined()
  })

  it('进行中的项（无 result、未跳过）不产生行', () => {
    const sessions = [session([confirmedItem('n1', 'good', 100)])]
    const active: ReviewSessionRecord = {
      ...session([
        { ...confirmedItem('n1', 'good', 999), result: undefined, phase: 'answering' },
      ]),
      status: 'active',
    }
    const history = reviewHistoryForNode([sessions[0], active], 'n1' as Id)
    expect(history.total).toBe(1)
  })

  it('limit 截断最近 N 条，total 保留全量数', () => {
    const sessions = [
      session([
        confirmedItem('n1', 'good', 100),
        confirmedItem('n1', 'good', 200),
        confirmedItem('n1', 'hard', 300),
      ]),
    ]
    const history = reviewHistoryForNode(sessions, 'n1' as Id, 2)
    expect(history.total).toBe(3)
    expect(history.rows).toHaveLength(2)
    expect(history.rows[0].at).toBe(300)
  })

  it('没有历史时为空', () => {
    expect(reviewHistoryForNode([], 'n1' as Id)).toEqual({ total: 0, rows: [] })
  })
})
