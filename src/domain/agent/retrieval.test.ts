import { describe, expect, it } from 'vitest'
import type { Message, Node, Note } from '@/domain/models'
import { makeMessage, makeNode, messagesByNode } from '@/test/fixtures'
import {
  getNodeDetail,
  labelStats,
  searchLabeledNotes,
  searchNodes,
  treeOutline,
  type ProjectSnapshot,
} from './retrieval'

function note(partial: Partial<Note> & { id: string }): Note {
  return {
    projectId: 'p1',
    nodeId: 'n1',
    messageId: 'm1',
    labels: [],
    quote: partial.id,
    start: 0,
    end: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

function snapshot(nodes: Node[], messages: Array<[string, Message[]]>, notes: Note[] = []): ProjectSnapshot {
  return { nodes, messagesByNode: messagesByNode(messages), notes }
}

describe('searchNodes', () => {
  const root = makeNode({ id: 'n1', title: '动量守恒' })
  const child: Node = {
    ...makeNode({ id: 'n2', parentId: 'n1', title: '角动量' }),
    summary: '与动量守恒的对照',
  }
  const archived: Node = { ...makeNode({ id: 'n3', title: '动量守恒（归档）' }), status: 'archived' }
  const center: Node = { ...makeNode({ id: 'n4', title: '动量守恒复习中心' }), kind: 'review' }

  it('matches title, summary and message content, and never the archived / review nodes', () => {
    const messages = [
      ['n2', [makeMessage({ id: 'm2', nodeId: 'n2', role: 'assistant', parts: [{ type: 'text', text: '守恒量在碰撞里最重要' }] })]],
    ] as Array<[string, Message[]]>
    const snap = snapshot([root, child, archived, center], messages)

    const byTitle = searchNodes(snap, '动量守恒')
    expect(byTitle.map((hit) => hit.nodeId)).toEqual(['n1', 'n2'])

    expect(searchNodes(snap, '碰撞').map((hit) => hit.nodeId)).toEqual(['n2'])
    expect(searchNodes(snap, '没出现过')).toEqual([])
  })

  it('ranks title matches above summary, and summary above conversation', () => {
    const titled = makeNode({ id: 'a', title: '特征值' })
    const summarized: Node = { ...makeNode({ id: 'b', title: '别的' }), summary: '特征值相关' }
    const inMessage = makeNode({ id: 'c', title: '再别的' })
    const snap = snapshot(
      [inMessage, summarized, titled],
      [
        ['c', [makeMessage({ id: 'm', nodeId: 'c', role: 'assistant', parts: [{ type: 'text', text: '特征值' }] })]],
      ] as Array<[string, Message[]]>,
    )

    expect(searchNodes(snap, '特征值').map((hit) => hit.nodeId)).toEqual(['a', 'b', 'c'])
  })

  it('drops blank queries and caps the result count', () => {
    const nodes = Array.from({ length: 30 }, (_, index) => makeNode({ id: `n${index}`, title: `主题${index}` }))
    const snap = snapshot(nodes, [])

    expect(searchNodes(snap, '   ')).toEqual([])
    expect(searchNodes(snap, '主题', 5)).toHaveLength(5)
    // 上限硬顶在 20，模型要不到更多
    expect(searchNodes(snap, '主题', 100)).toHaveLength(20)
  })
})

describe('getNodeDetail', () => {
  it('returns the ancestor path and the most recent messages of the display path', () => {
    const root = makeNode({ id: 'n1', title: '根' })
    const node: Node = { ...makeNode({ id: 'n2', parentId: 'n1', title: '子' }), mastery: { score: 60, weakPoints: ['边界'], updatedAt: 1 } }
    const messages = [
      makeMessage({ id: 'm1', nodeId: 'n2', role: 'user', parts: [{ type: 'text', text: '问题一' }] }),
      makeMessage({ id: 'm2', nodeId: 'n2', role: 'assistant', parts: [{ type: 'text', text: '回答一' }] }),
      makeMessage({ id: 'm3', nodeId: 'n2', role: 'user', parts: [{ type: 'text', text: '问题二' }] }),
    ]
    const snap = snapshot([root, node], [['n2', messages]])

    const detail = getNodeDetail(snap, 'n2', 2)!
    expect(detail.path).toEqual(['根', '子'])
    expect(detail.score).toBe(60)
    expect(detail.weakPoints).toEqual(['边界'])
    expect(detail.recentMessages.map((message) => message.text)).toEqual(['回答一', '问题二'])
  })

  it('returns null for an unknown node', () => {
    expect(getNodeDetail(snapshot([], []), 'nope')).toBeNull()
  })
})

describe('treeOutline', () => {
  it('lists active nodes with depth and drops archived / review centers', () => {
    const root = makeNode({ id: 'n1', title: '根' })
    const child = makeNode({ id: 'n2', parentId: 'n1', title: '子' })
    const archived: Node = { ...makeNode({ id: 'n3', title: '归档' }), status: 'archived' }
    const outline = treeOutline(snapshot([child, archived, root], []))

    expect(outline.map((entry) => [entry.nodeId, entry.depth])).toEqual([
      ['n1', 0],
      ['n2', 1],
    ])
  })
})

describe('labelStats', () => {
  it('counts only labeled notes and names built-in labels', () => {
    const stats = labelStats([
      note({ id: 'a', labels: ['mistake'] }),
      note({ id: 'b', labels: ['mistake', 'confusing'] }),
      note({ id: 'c', labels: [] }),
      note({ id: 'd', labels: ['自定义'] }),
    ])

    expect(stats).toEqual([
      { label: 'mistake', name: '错题', count: 2 },
      { label: 'confusing', name: '没懂', count: 1 },
      { label: '自定义', name: '自定义', count: 1 },
    ])
  })
})

describe('searchLabeledNotes', () => {
  const node = makeNode({ id: 'n1', title: '动量守恒' })
  const notes = [
    note({ id: '错题一', nodeId: 'n1', labels: ['mistake'], quote: '忽略竖直方向', body: '当时想错了', createdAt: 10 }),
    note({ id: '没懂一', nodeId: 'n1', labels: ['confusing'], quote: 'F = dp/dt 的适用条件', createdAt: 20 }),
    note({ id: '书签', nodeId: 'n1', labels: [], quote: '纯高亮原文', createdAt: 30 }),
  ]
  const snap = snapshot([node], [], notes)

  it('never returns plain highlights, and always carries the node title', () => {
    const result = searchLabeledNotes(snap, {})
    expect(result.total).toBe(2)
    expect(result.hits.map((hit) => hit.noteId)).toEqual(['没懂一', '错题一'])
    expect(result.hits.every((hit) => hit.nodeTitle === '动量守恒')).toBe(true)
    expect(result.hits[0].labelsText).toBe('[没懂]')
  })

  it('filters by any of the given labels (OR)', () => {
    expect(searchLabeledNotes(snap, { labels: ['mistake'] }).hits.map((hit) => hit.noteId)).toEqual([
      '错题一',
    ])
    expect(
      searchLabeledNotes(snap, { labels: ['mistake', 'confusing'] }).hits.map((hit) => hit.noteId),
    ).toEqual(['没懂一', '错题一'])
  })

  it('searches the quote and the body, and reports the unmatched total', () => {
    expect(searchLabeledNotes(snap, { query: '竖直' }).hits[0].noteId).toBe('错题一')
    expect(searchLabeledNotes(snap, { query: '想错' }).hits[0].noteId).toBe('错题一')
    // 纯高亮的原文不在检索范围内 —— 它是书签，不外送
    expect(searchLabeledNotes(snap, { query: '纯高亮' }).total).toBe(0)
  })

  it('honours the node filter and the limit', () => {
    expect(searchLabeledNotes(snap, { nodeId: 'n2' }).total).toBe(0)
    expect(searchLabeledNotes(snap, { limit: 1 }).hits).toHaveLength(1)
    expect(searchLabeledNotes(snap, { limit: 1 }).total).toBe(2)
  })
})