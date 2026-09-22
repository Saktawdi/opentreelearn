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

  it('injects project name and description when provided', () => {
    const node = makeNode({ id: 'n1', createdAt: 1 })
    const result = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', []]]),
      projectName: '深入理解计算机系统',
      projectDescription: '从程序员视角理解底层硬件与系统软件',
    })
    expect(result.system).toContain('## 所属学习项目')
    expect(result.system).toContain('- **名称**：深入理解计算机系统')
    expect(result.system).toContain('- **描述**：从程序员视角理解底层硬件与系统软件')
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

  it('only feeds the displayed version into the model context', () => {
    const node = makeNode({
      id: 'n1',
      createdAt: 1,
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
    })

    const result = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([
        ['n1', [
          makeMessage({ id: 'u1', nodeId: 'n1', parts: [{ type: 'text', text: '旧提问' }] }),
          makeMessage({
            id: 'a1',
            nodeId: 'n1',
            role: 'assistant',
            parts: [{ type: 'text', text: '旧回答不该进上下文' }],
          }),
          makeMessage({ id: 'u2', nodeId: 'n1', parts: [{ type: 'text', text: '新提问' }] }),
          makeMessage({
            id: 'a2',
            nodeId: 'n1',
            role: 'assistant',
            parts: [{ type: 'text', text: '新回答' }],
          }),
        ]],
      ]),
    })

    expect(result.messages.map((message) => message.parts[0])).toEqual([
      { type: 'text', text: '新提问' },
      { type: 'text', text: '新回答' },
    ])
  })

  it('resolves the fork source with the frozen version selection', () => {
    const thread = {
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
    }
    const source = makeNode({ id: 'a', createdAt: 1, thread })
    const forked = makeNode({
      id: 'b',
      parentId: 'a',
      forkFrom: { nodeId: 'a', messageId: 'a1', selection: { u1: 1 } },
      createdAt: 2,
    })

    const result = assembleContext({
      node: forked,
      nodes: [source, forked],
      messagesByNode: messagesByNode([
        ['a', [
          makeMessage({ id: 'u1', nodeId: 'a', parts: [{ type: 'text', text: 'v1 提问' }] }),
          makeMessage({ id: 'a1', nodeId: 'a', role: 'assistant', parts: [{ type: 'text', text: 'v1 回答' }] }),
          makeMessage({ id: 'u2', nodeId: 'a', parts: [{ type: 'text', text: 'v2 提问' }] }),
          makeMessage({ id: 'a2', nodeId: 'a', role: 'assistant', parts: [{ type: 'text', text: 'v2 回答' }] }),
        ]],
        ['b', []],
      ]),
    })

    expect(result.messages.map((message) => message.parts[0])).toEqual([
      { type: 'text', text: 'v1 提问' },
      { type: 'text', text: 'v1 回答' },
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

  it('sends the review center a study digest instead of a tree position', () => {
    const topic = makeNode({ id: 't1', title: '特征值', createdAt: 1 })
    topic.mastery = { score: 72, updatedAt: 2, weakPoints: ['边界条件'] }
    topic.lastStudiedAt = 3
    const center = makeNode({ id: 'review', title: '复习中心', kind: 'review', createdAt: 4 })

    const result = assembleContext({
      node: center,
      nodes: [topic, center],
      messagesByNode: messagesByNode([['review', []]]),
      now: 5,
    })

    expect(result.system).toContain('复习中心')
    expect(result.system).toContain('学习快照')
    expect(result.system).toContain('《特征值》')
    expect(result.system).toContain('档位 good')
    expect(result.system).toContain('薄弱：边界条件')
    expect(result.system).toContain('不要修改其他节点的任何数据')
    // 元数据节点不该出现在「当前学习位置」里
    expect(result.system).not.toContain('当前学习位置')
  })

  it('tells the tutor to elicit recall and emit a rating during a review session', () => {
    const node = makeNode({ id: 'n1', title: '特征值', createdAt: 1 })

    const normal = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', []]]),
    })
    const reviewing = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', []]]),
      reviewMode: 'review',
    })
    const relearning = assembleContext({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', []]]),
      reviewMode: 'relearn',
    })

    expect(normal.system).not.toContain('主动回忆')
    expect(reviewing.system).toContain('主动回忆')
    expect(reviewing.system).toContain('[[rating:again|hard|good|easy]]')
    // 重新学习不是硬回忆：先补最小必要的讲解
    expect(relearning.system).toContain('重新学习')
    expect(relearning.system).not.toContain('主动回忆')
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