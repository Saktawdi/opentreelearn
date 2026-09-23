import { describe, expect, it } from 'vitest'
import type { Message, Node, Project } from '@/domain/models'
import { parseTreeJson } from '@/services/import/tree-file'
import { buildTreeExportData, stringifyTreeExport } from './tree-export'

describe('tree-export', () => {
  it('converts Project, Nodes and Messages into standard .tree JSON format', () => {
    const project: Project = {
      id: 'p-1',
      name: '测试导出项目',
      tags: ['考研', '数学'],
      createdAt: 1000,
      updatedAt: 2000,
    }

    const nodes: Node[] = [
      {
        id: 'n-root',
        projectId: 'p-1',
        parentId: null,
        forkFrom: null,
        title: '极限与连续',
        position: { x: 100, y: 200 },
        status: 'active',
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'n-child1',
        projectId: 'p-1',
        parentId: 'n-root',
        forkFrom: null,
        title: '泰勒公式展开',
        contextSeed: ['引用前文极限知识'],
        position: { x: 300, y: 400 },
        status: 'active',
        createdAt: 1100,
        updatedAt: 1100,
      },
      {
        id: 'n-archived',
        projectId: 'p-1',
        parentId: 'n-root',
        forkFrom: null,
        title: '已归档草稿',
        position: null,
        status: 'archived',
        createdAt: 1200,
        updatedAt: 1200,
      },
    ]

    const messages: Message[] = [
      {
        id: 'm-1',
        nodeId: 'n-root',
        projectId: 'p-1',
        role: 'user',
        parts: [{ type: 'text', text: '什么是麦克劳林公式？' }],
        createdAt: 1010,
      },
      {
        id: 'm-2',
        nodeId: 'n-root',
        projectId: 'p-1',
        role: 'assistant',
        parts: [{ type: 'text', text: '麦克劳林公式是泰勒公式在 x=0 处的特例。' }],
        createdAt: 1020,
      },
      {
        id: 'm-3',
        nodeId: 'n-child1',
        projectId: 'p-1',
        role: 'user',
        parts: [{ type: 'text', text: '求 sin x 的展开式' }],
        createdAt: 1110,
      },
    ]

    const exported = buildTreeExportData(project, nodes, messages)

    expect(exported.type).toBe('project')
    expect(exported.version).toBe(2)
    expect(exported.data.name).toBe('测试导出项目')
    // v2 包含归档节点（带 archived: true，不静默丢子树）
    expect(exported.data.cards.length).toBe(3)

    const rootCard = exported.data.cards.find((c) => c.id === 'n-root')!
    const childCard = exported.data.cards.find((c) => c.id === 'n-child1')!
    const archivedCard = exported.data.cards.find((c) => c.id === 'n-archived')!

    expect(rootCard.title).toBe('极限与连续')
    expect(rootCard.children).toEqual(['n-child1', 'n-archived'])
    expect(rootCard.position).toEqual([100, 200, 0])
    // 卡片时间必须跟着走：画布按 createdAt 排布，导入端没它就只能自己合成
    expect(rootCard.createdAt).toBe(1000)
    expect(childCard.createdAt).toBe(1100)
    expect(rootCard.messages.length).toBe(2)
    expect(rootCard.messages[0].role).toBe('user')
    expect(rootCard.messages[1].role).toBe('ai')
    expect(archivedCard.archived).toBe(true)

    expect(childCard.messages[0].context).toEqual(['引用前文极限知识'])

    // Round-trip 测试：导出的 JSON 可以被 parseTreeJson 成功解析无损还原
    const jsonStr = stringifyTreeExport(exported)
    const reparsed = parseTreeJson(JSON.parse(jsonStr))

    expect(reparsed.name).toBe('测试导出项目')
    expect(reparsed.stats.cards).toBe(3)
    expect(reparsed.stats.roots).toBe(1)
    expect(reparsed.stats.messages).toBe(3)
    expect(reparsed.stats.contextSeeds).toBe(1)

    const reparsedChild = reparsed.cards.find((c) => c.sourceId === 'n-child1')!
    expect(reparsedChild.parentSourceId).toBe('n-root')
    expect(reparsedChild.contextSeed).toEqual(['引用前文极限知识'])
    expect(reparsedChild.createdAt).toBe(1100)
    expect(reparsed.cards.find((c) => c.sourceId === 'n-archived')?.status).toBe('archived')
  })

  it('carries mastery and the review-center mark, without the rating markers', () => {
    const project: Project = {
      id: 'p-1',
      name: '复习项目',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const topic: Node = {
      id: 'n-topic',
      projectId: 'p-1',
      parentId: null,
      forkFrom: null,
      title: '特征值',
      position: null,
      status: 'active',
      mastery: { score: 72, weakPoints: ['边界条件', '符号'], updatedAt: 5 },
      createdAt: 1,
      updatedAt: 1,
    }
    const center: Node = {
      id: 'n-center',
      projectId: 'p-1',
      parentId: null,
      forkFrom: null,
      title: '复习中心',
      position: null,
      status: 'active',
      kind: 'review',
      createdAt: 2,
      updatedAt: 2,
    }
    const messages: Message[] = [
      {
        id: 'm-1',
        nodeId: 'n-topic',
        projectId: 'p-1',
        role: 'assistant',
        parts: [{ type: 'text', text: '先复述定义。\n\n[[rating:good]]' }],
        createdAt: 3,
      },
    ]

    const exported = buildTreeExportData(project, [topic, center], messages)
    const topicCard = exported.data.cards.find((card) => card.id === 'n-topic')!
    const centerCard = exported.data.cards.find((card) => card.id === 'n-center')!

    expect(topicCard.mastery).toEqual({
      score: 72,
      weakPoints: ['边界条件', '符号'],
      updatedAt: 5,
    })
    expect(centerCard.kind).toBe('review')
    expect(centerCard.mastery).toBeUndefined()
    // 评分标记是应用内协议，不进导出文件
    expect(topicCard.messages[0].content).toBe('先复述定义。')

    // 再导入时掌握度与复习中心标记都还在，且快照时间被保留
    const reparsed = parseTreeJson(JSON.parse(stringifyTreeExport(exported)))
    const reparsedTopic = reparsed.cards.find((card) => card.sourceId === 'n-topic')!
    const reparsedCenter = reparsed.cards.find((card) => card.sourceId === 'n-center')!
    expect(reparsedTopic.mastery).toEqual({
      score: 72,
      weakPoints: ['边界条件', '符号'],
      updatedAt: 5,
    })
    expect(reparsedCenter.kind).toBe('review')
  })

  it('exports only the displayed version (lossy by design)', () => {
    const project: Project = {
      id: 'p-1',
      name: '版本项目',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const node: Node = {
      id: 'n-root',
      projectId: 'p-1',
      parentId: null,
      forkFrom: null,
      title: '版本节点',
      position: null,
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      thread: {
        entries: [{ slot: 'u1' }],
        slots: {
          u1: {
            versions: [
              { version: 1, entries: ['u1', 'a1'] },
              { version: 2, entries: ['u2', 'a2'] },
            ],
          },
        },
        selection: { u1: 2 },
      },
    }
    const messages: Message[] = ['u1', 'a1', 'u2', 'a2'].map((id, index) => ({
      id,
      nodeId: 'n-root',
      projectId: 'p-1',
      role: index % 2 === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: id }],
      createdAt: index,
    }))

    const exported = buildTreeExportData(project, [node], messages)
    expect(exported.data.cards[0].messages.map((message) => message.id)).toEqual(['u2', 'a2'])
  })
})

describe('tree-export: notes with labels', () => {
  const project: Project = { id: 'p-1', name: '标注项目', tags: [], createdAt: 1, updatedAt: 2 }
  const node: Node = {
    id: 'n-1',
    projectId: 'p-1',
    parentId: null,
    forkFrom: null,
    title: '动量守恒',
    position: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
  }
  const message: Message = {
    id: 'm-1',
    nodeId: 'n-1',
    projectId: 'p-1',
    role: 'assistant',
    parts: [{ type: 'text', text: '判断动量是否守恒时忽略了竖直方向' }],
    createdAt: 3,
  }

  it('writes labels and keeps a kind hint for older readers', () => {
    const data = buildTreeExportData(project, [node], [message], [
      {
        id: 'note-1',
        projectId: 'p-1',
        nodeId: 'n-1',
        messageId: 'm-1',
        labels: ['mistake'],
        quote: '忽略了竖直方向',
        start: 8,
        end: 16,
        createdAt: 4,
        updatedAt: 4,
      },
    ])

    const raw = data.data.notes![0]
    expect(raw.labels).toEqual(['mistake'])
    // 没有备注 ⇒ 老读者按纯高亮渲染；有备注则按批注渲染。标签本身是老读者不认识的字段
    expect(raw.kind).toBe('highlight')
  })

  it('round-trips labels through export → parse', () => {
    const data = buildTreeExportData(project, [node], [message], [
      {
        id: 'note-1',
        projectId: 'p-1',
        nodeId: 'n-1',
        messageId: 'm-1',
        labels: ['mistake', 'confusing'],
        quote: '忽略了竖直方向',
        start: 8,
        end: 16,
        body: '当时想错了',
        createdAt: 4,
        updatedAt: 4,
      },
    ])

    // 导出文件里的消息 id 会重编号吗？这里导出的是原 id，解析端按原 id 读
    const parsed = parseTreeJson(JSON.parse(stringifyTreeExport(data)))
    expect(parsed.notes[0]).toMatchObject({
      labels: ['mistake', 'confusing'],
      quote: '忽略了竖直方向',
      body: '当时想错了',
    })
  })

  it('omits the labels field for plain highlights', () => {
    const data = buildTreeExportData(project, [node], [message], [
      {
        id: 'note-2',
        projectId: 'p-1',
        nodeId: 'n-1',
        messageId: 'm-1',
        labels: [],
        quote: '竖直方向',
        start: 8,
        end: 12,
        createdAt: 4,
        updatedAt: 4,
      },
    ])

    expect(data.data.notes![0].labels).toBeUndefined()
    expect(data.data.notes![0].kind).toBe('highlight')
  })
})
