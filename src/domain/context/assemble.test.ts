import { describe, expect, it } from 'vitest'
import { makeMessage, makeNode, longText, messagesByNode } from '@/test/fixtures'
import { assembleContext, collectHistorySegments } from './assemble'

describe('collectHistorySegments', () => {
  it('returns only the node itself for a blank node', () => {
    const node = makeNode({ id: 'n1', createdAt: 1 })
    const segments = collectHistorySegments(
      node,
      [node],
      messagesByNode([['n1', [makeMessage({ id: 'm1', nodeId: 'n1' })]]]),
    )
    expect(segments.map((segment) => segment.node.id)).toEqual(['n1'])
  })

  it('walks the ancestor path and truncates at the fork message', () => {
    const a = makeNode({ id: 'a', createdAt: 1 })
    const b = makeNode({ id: 'b', parentId: 'a', forkFrom: { nodeId: 'a', messageId: 'a2' }, createdAt: 2 })
    const messages = messagesByNode([
      ['a', [
        makeMessage({ id: 'a1', nodeId: 'a', createdAt: 1 }),
        makeMessage({ id: 'a2', nodeId: 'a', createdAt: 2 }),
        makeMessage({ id: 'a3', nodeId: 'a', createdAt: 3 }),
      ]],
    ])

    const segments = collectHistorySegments(b, [a, b], messages)
    expect(segments).toHaveLength(2)
    expect(segments[0].messages.map((message) => message.id)).toEqual(['a1', 'a2'])
  })
})

describe('assembleContext', () => {
  it('injects contextSeed when present on the node', () => {
    const node = makeNode({
      id: 'seed-node',
      title: '导数定义',
      contextSeed: ['前置要点：已学过极限四则运算', '注意点：区分左右极限'],
    })

    const result = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['seed-node', []]]),
    })

    expect(result.system).toContain('本节点建立时的上下文')
    expect(result.system).toContain('已学过极限四则运算')
    expect(result.system).toContain('区分左右极限')
  })

  it('injects the learner background and the learning position', () => {
    const a = makeNode({ id: 'a', title: '线性代数', createdAt: 1 })
    const b = makeNode({
      id: 'b',
      title: '特征值',
      parentId: 'a',
      forkFrom: { nodeId: 'a', messageId: 'a1' },
      createdAt: 2,
    })

    const result = assembleContext({
      node: b,
      nodes: [a, b],
      messagesByNode: messagesByNode([
        ['a', [
          makeMessage({ id: 'a1', nodeId: 'a', parts: [{ type: 'text', text: '什么是矩阵' }] }),
        ]],
        ['b', []],
      ]),
      backgroundProfile: '计算机专业本科生',
    })

    expect(result.system).toContain('计算机专业本科生')
    expect(result.system).toContain('线性代数')
    expect(result.system).toContain('特征值')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('user')
  })

  it('prefers the project background over the global profile', () => {
    const node = makeNode({ id: 'n1', createdAt: 1 })
    const result = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', []]]),
      backgroundProfile: '全局背景',
      projectBackground: '项目背景',
    })
    expect(result.system).toContain('项目背景')
    expect(result.system).not.toContain('全局背景')
  })

  it('resolves image parts to data urls and falls back to a placeholder', () => {
    const node = makeNode({ id: 'n1', createdAt: 1 })
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', assetId: 'asset-1' },
        { type: 'image', assetId: 'asset-2' },
      ],
    })

    const result = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', [message]]]),
      assetUrls: new Map([['asset-1', 'data:image/png;base64,AAA']]),
    })

    expect(result.messages[0].parts).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAA' },
      { type: 'text', text: '［图片］' },
    ])
  })

  it('renders quote parts as markdown quotes ahead of the learner text', () => {
    const node = makeNode({ id: 'n1', createdAt: 1 })
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [
        { type: 'quote', text: '割线斜率的极限是切线斜率' },
        { type: 'text', text: '这为什么成立？' },
      ],
    })

    const result = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', [message]]]),
    })

    expect(result.messages[0].parts).toEqual([
      { type: 'text', text: '> 割线斜率的极限是切线斜率' },
      { type: 'text', text: '这为什么成立？' },
    ])
  })

  it('compacts the farthest history node first when over budget', () => {
    const a = makeNode({ id: 'a', title: '第一层', createdAt: 1 })
    const b = makeNode({
      id: 'b',
      title: '第二层',
      parentId: 'a',
      forkFrom: { nodeId: 'a', messageId: 'a2' },
      createdAt: 2,
    })
    const c = makeNode({
      id: 'c',
      title: '第三层',
      parentId: 'b',
      forkFrom: { nodeId: 'b', messageId: 'b2' },
      createdAt: 3,
    })

    const result = assembleContext({
      node: c,
      nodes: [a, b, c],
      messagesByNode: messagesByNode([
        ['a', [
          makeMessage({ id: 'a1', nodeId: 'a', parts: [{ type: 'text', text: longText('a1', 2000) }] }),
          makeMessage({ id: 'a2', nodeId: 'a', role: 'assistant', parts: [{ type: 'text', text: longText('a2', 2000) }] }),
        ]],
        ['b', [
          makeMessage({ id: 'b1', nodeId: 'b', parts: [{ type: 'text', text: longText('b1', 400) }] }),
          makeMessage({ id: 'b2', nodeId: 'b', role: 'assistant', parts: [{ type: 'text', text: longText('b2', 400) }] }),
        ]],
        ['c', []],
      ]),
      budgetTokens: 2000,
    })

    expect(result.stats.compactedNodeIds).toEqual(['a'])
    expect(result.stats.droppedNodeIds).toEqual([])
    expect(result.system).toContain('前置脉络')
    expect(result.messages).toHaveLength(2)
  })

  it('degrades to a minimal context when the budget is tiny', () => {
    const node = makeNode({ id: 'n1', createdAt: 1 })
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMessage({
        id: `m${i}`,
        nodeId: 'n1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: longText(`m${i}`, 600) }],
      }),
    )

    const result = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', messages]]),
      budgetTokens: 1400,
      recentMessages: 4,
    })

    expect(result.stats.estimatedTokens).toBeLessThanOrEqual(1400)
    expect(result.messages).toHaveLength(2)
    expect(result.stats.truncatedMessages).toBeGreaterThan(0)
  })
})