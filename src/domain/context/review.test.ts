import { describe, expect, it } from 'vitest'
import type { Node } from '@/domain/models'
import { makeNode } from '@/test/fixtures'
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

  it('formats topicPathLabel accurately', () => {
    const root = makeNode({ id: 'r', title: '高等代数' })
    const sub = makeNode({ id: 's', parentId: 'r', title: '向量空间' })
    const leaf = makeNode({ id: 'l', parentId: 's', title: '基与维数' })

    expect(topicPathLabel(leaf, [root, sub, leaf])).toBe('高等代数 / 向量空间 / 基与维数')
  })
})