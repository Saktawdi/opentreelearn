import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDatabase, getRepositories } from '@/data'
import type { ParsedProject } from './tree-file'
import { importParsedProject } from './index'

function makeParsed(cards: ParsedProject['cards']): ParsedProject {
  return {
    name: '导入项目',
    createdAt: 1_000,
    updatedAt: 2_000,
    cards,
    stats: { cards: cards.length, messages: 0, roots: 0, contextSeeds: 0, skippedMessages: 0 },
  }
}

beforeEach(async () => {
  const db = getDatabase()
  db.close()
  await db.delete()
  await db.open()
})

describe('importParsedProject', () => {
  it('sets lastStudiedAt from the latest message, not from the array order', async () => {
    const { project } = await importParsedProject(
      makeParsed([
        {
          sourceId: 'a',
          title: '特征值',
          parentSourceId: null,
          messages: [
            { role: 'assistant', content: '后答', createdAt: 900 },
            { role: 'user', content: '先问', createdAt: 800 },
          ],
        },
      ]),
    )

    const [node] = await getRepositories().nodes.listByProject(project.id)
    expect(node.lastStudiedAt).toBe(900)
  })

  it('falls back to the mastery snapshot time when the transcript is missing', async () => {
    const { project } = await importParsedProject(
      makeParsed([
        {
          sourceId: 'a',
          title: '只剩掌握度',
          parentSourceId: null,
          messages: [],
          mastery: { score: 72, weakPoints: ['边界条件'] },
        },
      ]),
    )

    const [node] = await getRepositories().nodes.listByProject(project.id)
    // 没有对话就没有「末条消息」，退回快照时间 —— 不能让 digest 显示成「尚未学习」
    expect(node.lastStudiedAt).toBe(node.mastery?.updatedAt)
  })

  it('leaves lastStudiedAt unset for nodes that were never studied', async () => {
    const { project } = await importParsedProject(
      makeParsed([
        { sourceId: 'a', title: '只有标题', parentSourceId: null, messages: [] },
      ]),
    )

    const [node] = await getRepositories().nodes.listByProject(project.id)
    expect(node.lastStudiedAt).toBeUndefined()
    expect(node.mastery).toBeUndefined()
  })
})
