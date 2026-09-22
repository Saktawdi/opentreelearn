import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDatabase, getRepositories } from '@/data'
import { computeTreeLayout } from '@/domain/tree/layout'
import type { ParsedProject } from './tree-file'
import { importParsedProject } from './index'

function makeParsed(cards: ParsedProject['cards'], notes: ParsedProject['notes'] = []): ParsedProject {
  return {
    name: '导入项目',
    createdAt: 1_000,
    updatedAt: 2_000,
    cards,
    notes,
    stats: {
      cards: cards.length,
      messages: 0,
      roots: 0,
      contextSeeds: 0,
      skippedMessages: 0,
      images: 0,
      notes: notes.length,
      forks: 0,
    },
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
          status: 'active',
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
          status: 'active',
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
        { sourceId: 'a', title: '只有标题', parentSourceId: null, status: 'active', messages: [] },
      ]),
    )

    const [node] = await getRepositories().nodes.listByProject(project.id)
    expect(node.lastStudiedAt).toBeUndefined()
    expect(node.mastery).toBeUndefined()
  })

  it('restores forkFrom with remapped node and message IDs', async () => {
    const { project } = await importParsedProject(
      makeParsed([
        {
          sourceId: 'src-node',
          title: '源主题',
          parentSourceId: null,
          status: 'active',
          messages: [
            { sourceId: 'src-msg-1', role: 'user', content: '问', createdAt: 10 },
            { sourceId: 'src-msg-2', role: 'assistant', content: '答', createdAt: 20 },
          ],
        },
        {
          sourceId: 'forked-node',
          title: '分支主题',
          parentSourceId: 'src-node',
          status: 'active',
          messages: [{ sourceId: 'fork-msg', role: 'user', content: '基于上一条答复继续问', createdAt: 30 }],
          forkFrom: { nodeSourceId: 'src-node', messageSourceId: 'src-msg-2' },
        },
      ]),
    )

    const nodes = await getRepositories().nodes.listByProject(project.id)
    const messages = await getRepositories().messages.listByProject(project.id)

    const srcNode = nodes.find((n) => n.title === '源主题')!
    const forkedNode = nodes.find((n) => n.title === '分支主题')!
    const targetMsg = messages.find((m) => m.nodeId === srcNode.id && m.role === 'assistant')!

    expect(forkedNode.forkFrom).toEqual({
      nodeId: srcNode.id,
      messageId: targetMsg.id,
    })
  })

  it('drops forkFrom when source node or message cannot be remapped', async () => {
    const { project } = await importParsedProject(
      makeParsed([
        {
          sourceId: 'orphan-fork',
          title: '悬空分支',
          parentSourceId: null,
          status: 'active',
          messages: [{ role: 'user', content: '一问', createdAt: 10 }],
          forkFrom: { nodeSourceId: 'missing-node', messageSourceId: 'missing-msg' },
        },
      ]),
    )

    const [node] = await getRepositories().nodes.listByProject(project.id)
    expect(node.forkFrom).toBeNull()
  })

  it('restores position, archived status, explicit reviewEnrollment, and notes', async () => {
    const { project } = await importParsedProject(
      makeParsed(
        [
          {
            sourceId: 'c1',
            title: '带坐标与复习状态的主题',
            parentSourceId: null,
            status: 'archived',
            position: { x: 120, y: 340 },
            messages: [{ sourceId: 'm1', role: 'user', content: '一段带有重点的内容', createdAt: 10 }],
            mastery: { score: 85, weakPoints: ['概念'], updatedAt: 500, gradedAt: 600 },
            reviewEnrollment: 'enabled',
            assessmentMeta: { assessedAt: 500, source: 'ai' },
          },
        ],
        [
          {
            sourceId: 'note-1',
            messageSourceId: 'm1',
            kind: 'highlight',
            quote: '重点',
            start: 4,
            end: 6,
            body: '这个是考点',
            createdAt: 100,
            updatedAt: 110,
          },
        ],
      ),
    )

    const [node] = await getRepositories().nodes.listByProject(project.id)
    expect(node.position).toEqual({ x: 120, y: 340 })
    expect(node.status).toBe('archived')
    expect(node.reviewEnrollment).toBe('enabled')
    expect(node.mastery?.updatedAt).toBe(500)
    expect(node.mastery?.gradedAt).toBe(600)
    expect(node.assessmentMeta?.source).toBe('ai')

    const [note] = await getRepositories().notes.listByProject(project.id)
    expect(note).toBeDefined()
    expect(note.nodeId).toBe(node.id)
    expect(note.quote).toBe('重点')
    expect(note.body).toBe('这个是考点')
  })

  it('keeps the file’s own creation times so the canvas order survives the import', async () => {
    const { project } = await importParsedProject(
      makeParsed([
        // 数组顺序与真实创建时间相反 —— 位置只认时间，不认数组下标
        {
          sourceId: 'newer',
          title: '第四天学习笔记',
          parentSourceId: null,
          status: 'active',
          createdAt: 9_000,
          updatedAt: 9_500,
          messages: [{ role: 'user', content: '第四天', createdAt: 9_000 }],
        },
        {
          sourceId: 'older',
          title: 'Day3学习笔记',
          parentSourceId: null,
          status: 'active',
          createdAt: 3_000,
          updatedAt: 3_000,
          messages: [{ role: 'user', content: '第三天', createdAt: 3_000 }],
        },
      ]),
    )

    const nodes = await getRepositories().nodes.listByProject(project.id)
    const older = nodes.find((node) => node.title === 'Day3学习笔记')!
    const newer = nodes.find((node) => node.title === '第四天学习笔记')!

    expect(older.createdAt).toBe(3_000)
    expect(newer.createdAt).toBe(9_000)
    expect(newer.updatedAt).toBe(9_500)

    // 画布的树布局按 createdAt 排根节点与同级节点：先建的那棵仍在左边，
    // 否则节点没丢却换了地方，用户会当成「整棵树不见了」
    const { positions } = computeTreeLayout(nodes)
    expect(positions.get(older.id)!.x).toBeLessThan(positions.get(newer.id)!.x)
  })

  it('falls back to the earliest message time when the file has no card timestamps', async () => {
    // v1 与外部工具的文件没有卡片时间戳：按首条消息定先后，而不是按数组顺序
    const { project } = await importParsedProject(
      makeParsed([
        {
          sourceId: 'late',
          title: '后来的树',
          parentSourceId: null,
          status: 'active',
          messages: [{ role: 'user', content: '晚', createdAt: 8_000 }],
        },
        {
          sourceId: 'early',
          title: '先建的树',
          parentSourceId: null,
          status: 'active',
          messages: [{ role: 'user', content: '早', createdAt: 2_000 }],
        },
      ]),
    )

    const nodes = await getRepositories().nodes.listByProject(project.id)
    const early = nodes.find((node) => node.title === '先建的树')!
    const late = nodes.find((node) => node.title === '后来的树')!

    expect(early.createdAt).toBe(2_000)
    expect(late.createdAt).toBe(8_000)

    const { positions } = computeTreeLayout(nodes)
    expect(positions.get(early.id)!.x).toBeLessThan(positions.get(late.id)!.x)
  })
})
