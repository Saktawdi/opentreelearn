import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDatabase, getRepositories } from '@/data'
import type { Node } from '@/domain/models'
import { createReviewCard } from '@/domain/review/fsrs'
import { useReviewStore } from './review-store'

const NOW = Date.now()

function assessed(id: string, projectId: string, due: number | null): Node {
  const node: Node = {
    id,
    projectId,
    parentId: null,
    forkFrom: null,
    title: id,
    position: null,
    status: 'active',
    mastery: { score: 70, updatedAt: NOW },
    createdAt: 1,
    updatedAt: 1,
  }
  if (due !== null) {
    node.review = { card: { ...createReviewCard(1), due } }
  }
  return node
}

beforeEach(async () => {
  const db = getDatabase()
  db.close()
  await db.delete()
  await db.open()
  useReviewStore.getState().reset()
})

describe('review store', () => {
  it('aggregates due and overdue counts per project', async () => {
    const yesterday = NOW - 2 * 24 * 60 * 60 * 1000
    await getRepositories().nodes.createMany([
      assessed('p1-due', 'p1', NOW - 60_000),
      assessed('p1-overdue', 'p1', yesterday),
      assessed('p1-future', 'p1', NOW + 24 * 60 * 60 * 1000),
      assessed('p2-due', 'p2', NOW - 60_000),
      assessed('no-card', 'p2', null),
    ])

    await useReviewStore.getState().load()
    const state = useReviewStore.getState()

    expect(state.summaries.p1).toEqual({ due: 2, overdue: 1 })
    expect(state.summaries.p2).toEqual({ due: 2, overdue: 0 })
    expect(state.total).toEqual({ due: 4, overdue: 1 })
  })

  it('reports nothing when there is nothing due', async () => {
    await getRepositories().nodes.create(
      assessed('future', 'p1', NOW + 24 * 60 * 60 * 1000),
    )

    await useReviewStore.getState().load()

    expect(useReviewStore.getState().summaries).toEqual({})
    expect(useReviewStore.getState().total).toEqual({ due: 0, overdue: 0 })
  })

  it('re-derives on every load, even after it has been loaded once', async () => {
    const node = assessed('p1-due', 'p1', NOW - 60_000)
    await getRepositories().nodes.create(node)
    await useReviewStore.getState().load()
    expect(useReviewStore.getState().total.due).toBe(1)
    expect(useReviewStore.getState().loaded).toBe(true)

    // 复习完：卡片被推远。再次 load 必须反映新状态（首页重新挂载时会调它）
    await getRepositories().nodes.update(node.id, {
      review: { card: { ...node.review!.card, due: NOW + 24 * 60 * 60 * 1000 } },
    })
    await useReviewStore.getState().load()

    expect(useReviewStore.getState().total).toEqual({ due: 0, overdue: 0 })
    expect(useReviewStore.getState().summaries).toEqual({})
    expect(useReviewStore.getState().loaded).toBe(true)
  })

  it('clears everything on reset so a database switch cannot show stale numbers', async () => {
    await getRepositories().nodes.create(assessed('p1-due', 'p1', NOW - 60_000))
    await useReviewStore.getState().load()

    useReviewStore.getState().reset()

    expect(useReviewStore.getState().loaded).toBe(false)
    expect(useReviewStore.getState().summaries).toEqual({})
    expect(useReviewStore.getState().total).toEqual({ due: 0, overdue: 0 })
  })
})