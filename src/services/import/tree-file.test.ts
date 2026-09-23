import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseTreeFileText, parseTreeJson, TreeParseError } from './tree-file'

// 真实样例是本地工件（.gate/chat-files 不在仓库里），缺失时跳过而不是让整套测试红掉
const REAL_TREE_FILE = '.gate/chat-files/20260920-192723-byrgemf6k-_______.tree'

const SYNTHETIC_TREE = {
  type: 'project',
  version: 1,
  data: {
    name: '测试树',
    cards: [
      {
        id: 'c1',
        title: '根卡片',
        messages: [
          { role: 'user', content: '第一问', timestamp: 100 },
          { role: 'ai', content: '第一答', timestamp: 110 },
        ],
        children: ['c2', 'c3'],
      },
      {
        id: 'c2',
        title: '子卡片 A',
        messages: [
          { role: 'user', content: '第二问', timestamp: 200, context: ['引用前文片段'] },
          { role: 'ai', content: '第二答', timestamp: 210 },
        ],
        children: [],
      },
      {
        id: 'c3',
        title: '子卡片 B',
        messages: [{ role: 'user', content: '第三问', timestamp: 300 }],
        children: [],
      },
    ],
  },
}

describe('parseTreeJson', () => {
  it('parses tree cards into a forest and maps ai role to assistant', () => {
    const parsed = parseTreeJson(SYNTHETIC_TREE)
    expect(parsed.name).toBe('测试树')
    expect(parsed.stats.cards).toBe(3)
    expect(parsed.stats.roots).toBe(1)
    expect(parsed.stats.messages).toBe(5)

    const c1 = parsed.cards.find((card) => card.sourceId === 'c1')!
    const c2 = parsed.cards.find((card) => card.sourceId === 'c2')!
    const c3 = parsed.cards.find((card) => card.sourceId === 'c3')!

    expect(c1.parentSourceId).toBeNull()
    expect(c2.parentSourceId).toBe('c1')
    expect(c3.parentSourceId).toBe('c1')

    expect(c1.messages[1].role).toBe('assistant')
    expect(c2.contextSeed).toEqual(['引用前文片段'])
  })

  it('breaks cycles defensively', () => {
    const cyclic = {
      type: 'project',
      version: 1,
      data: {
        cards: [
          { id: 'a', children: ['b'] },
          { id: 'b', children: ['a'] },
        ],
      },
    }
    const parsed = parseTreeJson(cyclic)
    expect(parsed.cards.some((card) => card.parentSourceId === null)).toBe(true)
  })

  it('rejects wrong type or malformed input', () => {
    expect(() => parseTreeJson({ type: 'card', version: 1, data: { cards: [] } })).toThrow(
      TreeParseError,
    )
    expect(() => parseTreeJson({})).toThrow(TreeParseError)
  })

  it('parses v2 extensions: position, archived, forkFrom, notes, image counts', () => {
    const v2Tree = {
      type: 'project',
      version: 2,
      data: {
        name: 'v2 完整项目',
        cards: [
          {
            id: 'c-root',
            title: '根卡片',
            position: [120, 240, 0],
            messages: [
              { id: 'm1', role: 'user', content: '一问', timestamp: 100 },
              { id: 'm2', role: 'assistant', content: '一答', timestamp: 110, images: 2 },
            ],
            children: ['c-child'],
            archived: false,
          },
          {
            id: 'c-child',
            title: '分支卡片',
            messages: [{ id: 'm3', role: 'user', content: '二问', timestamp: 200 }],
            children: [],
            archived: true,
            createdAt: 900,
            updatedAt: 1000,
            forkFrom: { nodeId: 'c-root', messageId: 'm2' },
            reviewEnrollment: 'enabled',
            mastery: { score: 90, weakPoints: ['易错点'], updatedAt: 1500, gradedAt: 1600 },
            assessmentMeta: { assessedAt: 1500, basedOnStudiedAt: 110, source: 'ai' },
          },
        ],
        notes: [
          {
            id: 'n1',
            messageId: 'm2',
            kind: 'annotation',
            labels: ['mistake', '  没懂  ', 'mistake'],
            quote: '答',
            start: 1,
            end: 2,
            body: '笔记内容',
            createdAt: 300,
            updatedAt: 310,
          },
        ],
      },
    }

    const parsed = parseTreeJson(v2Tree)
    expect(parsed.stats.cards).toBe(2)
    expect(parsed.stats.notes).toBe(1)
    expect(parsed.stats.images).toBe(2)
    expect(parsed.stats.forks).toBe(1)

    const root = parsed.cards.find((c) => c.sourceId === 'c-root')!
    const child = parsed.cards.find((c) => c.sourceId === 'c-child')!

    expect(root.position).toEqual({ x: 120, y: 240 })
    expect(root.status).toBe('active')
    expect(root.createdAt).toBeUndefined()
    expect(child.status).toBe('archived')
    // 卡片自带的时间要读出来：画布按 createdAt 排布，导入端靠它还原原样
    expect(child.createdAt).toBe(900)
    expect(child.updatedAt).toBe(1000)
    expect(child.forkFrom).toEqual({ nodeSourceId: 'c-root', messageSourceId: 'm2' })
    expect(child.reviewEnrollment).toBe('enabled')
    expect(child.mastery?.updatedAt).toBe(1500)
    expect(child.mastery?.gradedAt).toBe(1600)
    expect(child.assessmentMeta?.source).toBe('ai')

    expect(parsed.notes[0]).toMatchObject({
      messageSourceId: 'm2',
      // 标签去空白、去重；老文件的 kind 不再承担语义
      labels: ['mistake', '没懂'],
      quote: '答',
      body: '笔记内容',
    })
  })

  it('reads a v1 note (kind only) as an unlabeled highlight, keeping its body', () => {
    const v1Tree = {
      type: 'project',
      version: 1,
      data: {
        name: '老项目',
        cards: [
          {
            id: 'c1',
            title: '一问',
            messages: [{ id: 'm1', role: 'user', content: '一问', timestamp: 10 }],
            children: [],
          },
        ],
        notes: [
          { id: 'n1', messageId: 'm1', kind: 'annotation', quote: '问', start: 0, end: 1, body: '旧批注' },
        ],
        createdAt: 1,
        updatedAt: 2,
      },
    }

    const parsed = parseTreeJson(v1Tree)
    expect(parsed.notes[0]).toMatchObject({ labels: [], body: '旧批注' })
  })

  it.skipIf(!existsSync(REAL_TREE_FILE))('parses the real .gate file faithfully', () => {
    const text = readFileSync(REAL_TREE_FILE, 'utf-8')
    const parsed = parseTreeFileText(text)
    expect(parsed.name).toBe('考研数学二章节')
    expect(parsed.stats.cards).toBe(11)
    expect(parsed.stats.roots).toBe(3)
    expect(parsed.stats.messages).toBe(28)
    expect(parsed.stats.skippedMessages).toBe(4)
    expect(parsed.stats.contextSeeds).toBe(8)
  })
})