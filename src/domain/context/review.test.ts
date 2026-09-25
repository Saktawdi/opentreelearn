import { describe, expect, it } from 'vitest'
import type { Note, Node } from '@/domain/models'
import { makeMessage, makeNode, messagesByNode } from '@/test/fixtures'
import {
  assembleReviewContext,
  buildReviewMaterial,
  topicPathLabel,
} from './review'

const NOW = 1700000000000

describe('review context & material assembly', () => {
  it('builds review material with topic path and summary, generating a stable version fingerprint', () => {
    const parent = makeNode({ id: 'p1', title: '父节点' })
    const node: Node = {
      ...makeNode({ id: 'n1', parentId: 'p1', title: '当前主题' }),
      summary: '核心概念已掌握',
      mastery: { score: 85, weakPoints: ['推导边界'], updatedAt: NOW },
    }

    const messagesByNode = new Map()
    const material = buildReviewMaterial({
      node,
      nodes: [parent, node],
      messagesByNode,
    })

    expect(material.text).toContain('父节点')
    expect(material.text).toContain('当前主题')
    expect(material.text).toContain('核心概念已掌握')
    expect(material.text).toContain('推导边界')
    expect(material.versionId).toBeTruthy()
    expect(material.truncated).toBe(false)
  })

  it('assembles review context with appropriate purpose rules and prevents answer leakage on question purpose', () => {
    const node: Node = makeNode({ id: 'n1', title: '正交投影' })
    const material = {
      text: '## 学习资料\n正交投影定义与公式推导…',
      versionId: 'v1',
      truncated: false,
    }

    const ctx = assembleReviewContext({
      node,
      purpose: 'question',
      material,
      history: [],
      progressNote: '第 1 / 3 个主题',
    })

    expect(ctx.system).toContain('出**一道**需要主动回忆的题')
    expect(ctx.system).toContain('只出题，**不要给出答案、不要提示思路**')
    expect(ctx.system).toContain('不要输出任何评分标记')
    expect(ctx.system).toContain('第 1 / 3 个主题')
    expect(ctx.estimatedTokens).toBeGreaterThan(0)
  })

  it('includes rating marker hint on answer and followup feedback purposes', () => {
    const node: Node = makeNode({ id: 'n1', title: '特征值' })
    const material = { text: '## 资料', versionId: 'v1', truncated: false }

    const answerCtx = assembleReviewContext({
      node,
      purpose: 'answer',
      material,
      history: [],
    })
    expect(answerCtx.system).toContain('[[rating:again|hard|good|easy]]')

    const followupCtx = assembleReviewContext({
      node,
      purpose: 'followup',
      material,
      history: [],
    })
    expect(followupCtx.system).toContain('[[rating:again|hard|good|easy]]')
  })

  it('injects project name and description when provided', () => {
    const node: Node = makeNode({ id: 'n1', title: '正交投影' })
    const material = { text: '## 资料', versionId: 'v1', truncated: false }
    const ctx = assembleReviewContext({
      node,
      purpose: 'question',
      material,
      history: [],
      projectName: '高等代数',
      projectDescription: '线性空间与二次型精要',
    })
    expect(ctx.system).toContain('## 所属学习项目')
    expect(ctx.system).toContain('- **名称**：高等代数')
    expect(ctx.system).toContain('- **描述**：线性空间与二次型精要')
  })

  it('formats topicPathLabel accurately', () => {
    const root = makeNode({ id: 'r', title: '高等代数' })
    const sub = makeNode({ id: 's', parentId: 'r', title: '向量空间' })
    const leaf = makeNode({ id: 'l', parentId: 's', title: '基与维数' })

    expect(topicPathLabel(leaf, [root, sub, leaf])).toBe('高等代数 / 向量空间 / 基与维数')
  })
})
describe('review material: user annotations', () => {
  const note = (id: string, messageId: string, labels: string[], extra: Partial<Note> = {}): Note => ({
    id,
    projectId: 'p1',
    nodeId: 'n1',
    messageId,
    labels,
    quote: id,
    start: 0,
    end: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  })

  it('feeds labeled annotations into the material, keyed by message id', () => {
    // 回归测试：旧实现拿 nodeId 去查以 messageId 为键的表，这段材料从未生效过
    const node = makeNode({ id: 'n1', title: '动量守恒' })
    const messages = [
      makeMessage({ id: 'm1', nodeId: 'n1', role: 'user', parts: [{ type: 'text', text: '问题' }] }),
      makeMessage({
        id: 'm2',
        nodeId: 'n1',
        role: 'assistant',
        parts: [{ type: 'text', text: '忽略竖直方向就会出错' }],
      }),
    ]
    const notesByMessage = new Map([
      ['m2', [note('标注一', 'm2', ['mistake'], { quote: '忽略了竖直方向' })]],
    ])

    const material = buildReviewMaterial({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', messages]]),
      notesByMessage,
    })

    expect(material.text).toContain('## 用户标注（[错题] 1）')
    expect(material.text).toContain('「错题」= 学习者确认自己做错或答错的内容')
    expect(material.text).toContain('- [错题] 忽略了竖直方向')
  })

  it('never sends plain highlights and never sends a note body', () => {
    const node = makeNode({ id: 'n1' })
    const messages = [
      makeMessage({ id: 'm1', nodeId: 'n1', role: 'assistant', parts: [{ type: 'text', text: '正文' }] }),
    ]
    const notesByMessage = new Map([
      [
        'm1',
        [
          note('纯高亮', 'm1', [], { quote: '这句只是书签' }),
          note('带备注', 'm1', ['key'], { quote: '关键结论', body: '私有备注不该出现在这里' }),
        ],
      ],
    ])

    const material = buildReviewMaterial({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', messages]]),
      notesByMessage,
    })

    expect(material.text).toContain('- [关键] 关键结论')
    expect(material.text).not.toContain('这句只是书签')
    expect(material.text).not.toContain('私有备注不该出现在这里')
  })

  it('ignores annotations anchored to messages outside the display path', () => {
    const node = makeNode({ id: 'n1' })
    const messages = [
      makeMessage({ id: 'm1', nodeId: 'n1', role: 'assistant', parts: [{ type: 'text', text: '显示中' }] }),
      makeMessage({ id: 'm-hidden', nodeId: 'n1', role: 'assistant', parts: [{ type: 'text', text: '旧版本' }] }),
    ]
    const notesByMessage = new Map([
      ['m-hidden', [note('旧版标注', 'm-hidden', ['mistake'], { quote: '被切走的历史版本' })]],
    ])

    const material = buildReviewMaterial({
      node: { ...node, thread: { entries: ['m1'], slots: {} } },
      nodes: [node],
      messagesByNode: messagesByNode([['n1', messages]]),
      notesByMessage,
    })

    expect(material.text).not.toContain('被切走的历史版本')
  })
})

describe('review material: review-session annotations (origin=review)', () => {
  const node = makeNode({ id: 'n1', title: '区间代换' })

  it('sends labels and body but never the quoted text for review-origin annotations', () => {
    // 复习期标注锚在上一轮讲解上，quote 极可能就是答案本体：回送 = 把答案喂回下一轮
    const material = buildReviewMaterial({
      node,
      nodes: [node],
      messagesByNode: new Map(),
      reviewNotes: [
        {
          id: 'r1',
          projectId: 'p1',
          nodeId: 'n1',
          messageId: 'review-msg-1',
          labels: ['mistake'],
          quote: '单奇凑微分，全偶用降幂',
          start: 0,
          end: 12,
          body: '总是忘记先拆奇偶次幂',
          origin: 'review',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    expect(material.text).toContain('- [错题]（复习期标记）总是忘记先拆奇偶次幂')
    expect(material.text).toContain('不附原文')
    expect(material.text).not.toContain('单奇凑微分，全偶用降幂')
  })

  it('keeps a bare review-origin annotation as a weak signal without any text', () => {
    const material = buildReviewMaterial({
      node,
      nodes: [node],
      messagesByNode: new Map(),
      reviewNotes: [
        {
          id: 'r2',
          projectId: 'p1',
          nodeId: 'n1',
          messageId: 'review-msg-2',
          labels: ['confusing'],
          quote: '被标的那段讲解',
          start: 0,
          end: 7,
          origin: 'review',
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    })

    expect(material.text).toContain('- [没懂]（复习期标记）无备注')
    expect(material.text).not.toContain('被标的那段讲解')
  })

  it('puts the newest review annotation first and merges with chat annotations', () => {
    const messages = [
      makeMessage({ id: 'm1', nodeId: 'n1', role: 'assistant', parts: [{ type: 'text', text: '讲解' }] }),
    ]
    const material = buildReviewMaterial({
      node,
      nodes: [node],
      messagesByNode: messagesByNode([['n1', messages]]),
      notesByMessage: new Map([
        ['m1', [
          {
            id: 'c1', projectId: 'p1', nodeId: 'n1', messageId: 'm1',
            labels: ['key'], quote: '学习期的关键结论', start: 0, end: 8,
            createdAt: 1, updatedAt: 1,
          },
        ]],
      ]),
      reviewNotes: [
        {
          id: 'r-old', projectId: 'p1', nodeId: 'n1', messageId: 'rm1',
          labels: ['mistake'], quote: '旧', start: 0, end: 1, origin: 'review',
          createdAt: 10, updatedAt: 10,
        },
        {
          id: 'r-new', projectId: 'p1', nodeId: 'n1', messageId: 'rm2',
          labels: ['mistake'], quote: '新', start: 0, end: 1, origin: 'review',
          body: '最新的信号', createdAt: 20, updatedAt: 20,
        },
      ],
    })

    const text = material.text
    // 学习期标注照常带原文；两条复习期标注都进材料，最新的排前面
    expect(text).toContain('- [关键] 学习期的关键结论')
    expect(text).toContain('## 用户标注（')
    expect(text).toContain('[错题] 2')
    expect(text).toContain('[关键] 1')
    const newestAt = text.indexOf('（复习期标记）最新的信号')
    const oldestAt = text.indexOf('（复习期标记）无备注')
    expect(newestAt).toBeGreaterThan(-1)
    expect(oldestAt).toBeGreaterThan(newestAt)
  })
})
