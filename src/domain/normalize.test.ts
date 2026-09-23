import { describe, expect, it } from 'vitest'
import { createDefaultSettings, DEFAULT_CONTEXT_BUDGET } from './defaults'
import {
  normalizeGlobalSettings,
  normalizeMastery,
  normalizeModelRef,
  normalizeNode,
  normalizeNote,
  normalizeProject,
  normalizeProvider,
  normalizeReview,
} from './normalize'

describe('normalizeProject', () => {
  it('keeps well-formed records intact', () => {
    const project = {
      id: 'p1',
      name: '数学分析',
      description: '期末复习',
      tags: ['数学'],
      createdAt: 1,
      updatedAt: 2,
    }

    expect(normalizeProject(project)).toEqual(project)
  })

  it('repairs missing fields instead of leaving them undefined', () => {
    const now = 1_700_000_000_000
    const project = normalizeProject({ id: 'p1' }, now)

    expect(project).toEqual({
      id: 'p1',
      name: '未命名项目',
      description: undefined,
      tags: [],
      createdAt: now,
      updatedAt: now,
    })
  })

  it('drops non-string tags and trims the rest', () => {
    expect(normalizeProject({ id: 'p1', tags: [' 数学 ', '', 42, null, '物理'] })?.tags).toEqual([
      '数学',
      '物理',
    ])
    expect(normalizeProject({ id: 'p1', tags: '数学' })?.tags).toEqual([])
  })

  it('ignores non-numeric timestamps', () => {
    const project = normalizeProject({ id: 'p1', createdAt: '1', updatedAt: 5 }, 99)

    expect(project?.createdAt).toBe(99)
    expect(project?.updatedAt).toBe(5)
  })

  it('rejects records without a usable id', () => {
    expect(normalizeProject(null)).toBeNull()
    expect(normalizeProject('p1')).toBeNull()
    expect(normalizeProject({ id: '' })).toBeNull()
  })
})

describe('normalizeProvider', () => {
  it('requires an id and defaults the rest', () => {
    expect(normalizeProvider({ id: 'v1' })).toEqual({
      id: 'v1',
      label: '未命名提供商',
      kind: 'openai-compatible',
      apiKey: '',
      baseURL: undefined,
      models: [],
    })
    expect(normalizeProvider({ label: '没有 id' })).toBeNull()
    expect(normalizeProvider({ id: 'v1', models: [1, 'gpt-4o'] })?.models).toEqual(['gpt-4o'])
  })

  it('falls back to a known kind for unknown values', () => {
    expect(normalizeProvider({ id: 'v1', kind: 'anthropic' })?.kind).toBe('anthropic')
    expect(normalizeProvider({ id: 'v1', kind: 'gemini' })?.kind).toBe('openai-compatible')
  })
})

describe('normalizeModelRef', () => {
  it('needs both providerId and modelId', () => {
    expect(normalizeModelRef({ providerId: 'v1', modelId: 'm1' })).toEqual({
      providerId: 'v1',
      modelId: 'm1',
    })
    expect(normalizeModelRef({ providerId: 'v1' })).toBeNull()
    expect(normalizeModelRef(null)).toBeNull()
    expect(normalizeModelRef({ providerId: '', modelId: 'm1' })).toBeNull()
  })
})

describe('normalizeGlobalSettings', () => {
  it('returns defaults for junk input', () => {
    expect(normalizeGlobalSettings(undefined)).toEqual(createDefaultSettings())
    expect(normalizeGlobalSettings('nope')).toEqual(createDefaultSettings())
  })

  it('always yields an array of providers', () => {
    const settings = normalizeGlobalSettings({ providers: null })

    expect(settings.providers).toEqual([])
    expect(settings.contextBudget).toBe(DEFAULT_CONTEXT_BUDGET)
  })

  it('keeps valid providers and discards broken ones', () => {
    const settings = normalizeGlobalSettings({
      providers: [{ id: 'v1', label: '中转', kind: 'openai' }, { label: '缺 id' }, 7],
    })

    expect(settings.providers.map((provider) => provider.id)).toEqual(['v1'])
    expect(settings.providers[0].models).toEqual([])
  })

  it('clamps out-of-range budgets and nulls malformed model refs', () => {
    expect(normalizeGlobalSettings({ contextBudget: 10 }).contextBudget).toBe(2_000)
    expect(normalizeGlobalSettings({ contextBudget: 10_000_000 }).contextBudget).toBe(1_000_000)
    // 1M 是最大模型窗口的上限值，必须原样留下（不要被当成越界截断）
    expect(normalizeGlobalSettings({ contextBudget: 1_000_000 }).contextBudget).toBe(1_000_000)
    expect(normalizeGlobalSettings({ contextBudget: '24000' }).contextBudget).toBe(
      DEFAULT_CONTEXT_BUDGET,
    )
    expect(
      normalizeGlobalSettings({ defaultChatModelRef: { providerId: 'v1' } }).defaultChatModelRef,
    ).toBeNull()
  })
})

describe('normalizeMastery', () => {
  it('keeps a well-formed snapshot intact', () => {
    expect(normalizeMastery({ score: 72, weakPoints: ['边界'], updatedAt: 5 })).toEqual({
      score: 72,
      weakPoints: ['边界'],
      updatedAt: 5,
    })
  })

  it('clamps the score and caps weak points at three', () => {
    expect(normalizeMastery({ score: 140, updatedAt: 1 })?.score).toBe(100)
    expect(normalizeMastery({ score: -20, updatedAt: 1 })?.score).toBe(0)
    expect(normalizeMastery({ score: 66.6, updatedAt: 1 })?.score).toBe(67)
    expect(
      normalizeMastery({ score: 50, updatedAt: 1, weakPoints: ['a', 'b', 'c', 'd'] })?.weakPoints,
    ).toEqual(['a', 'b', 'c'])
  })

  it('drops the snapshot when there is no usable score', () => {
    expect(normalizeMastery({ updatedAt: 1 })).toBeUndefined()
    expect(normalizeMastery({ score: '80', updatedAt: 1 })).toBeUndefined()
    expect(normalizeMastery(null)).toBeUndefined()
  })

  it('keeps a score without a timestamp but marks it as ancient', () => {
    // 丢分数等于数据丢失；缺时间只是「不知道什么时候打的」，弱化显示即可
    expect(normalizeMastery({ score: 80 })).toEqual({ score: 80, updatedAt: 0 })
  })
})

describe('normalizeReview', () => {
  const card = {
    due: 1_000,
    stability: 12.5,
    difficulty: 5.2,
    scheduledDays: 10,
    learningSteps: 0,
    reps: 4,
    lapses: 1,
    state: 'review',
    lastReview: 500,
  }

  it('keeps a well-formed card intact', () => {
    expect(normalizeReview({ card, lastGrade: 'good' })).toEqual({ card, lastGrade: 'good' })
  })

  it('drops a half-broken card instead of letting FSRS schedule on bad data', () => {
    expect(normalizeReview({ card: { ...card, stability: 'high' } })).toBeUndefined()
    expect(normalizeReview({ card: { ...card, due: undefined } })).toBeUndefined()
    expect(normalizeReview({ card: null })).toBeUndefined()
    expect(normalizeReview({})).toBeUndefined()
  })

  it('falls back to new for an unknown state and drops an unknown grade', () => {
    const result = normalizeReview({ card: { ...card, state: 'someday' }, lastGrade: '完美' })
    expect(result?.card.state).toBe('new')
    expect(result?.lastGrade).toBeUndefined()
  })

  it('floors negative counters', () => {
    const result = normalizeReview({ card: { ...card, reps: -3, lapses: 2.9 } })
    expect(result?.card.reps).toBe(0)
    expect(result?.card.lapses).toBe(2)
  })
})

describe('normalizeNode', () => {
  const base = {
    id: 'n1',
    projectId: 'p1',
    parentId: null,
    forkFrom: null,
    title: '特征值',
    position: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
  }

  it('keeps old records working without the new fields', () => {
    const node = normalizeNode(base)

    expect(node).toMatchObject(base)
    expect(node?.kind).toBeUndefined()
    expect(node?.mastery).toBeUndefined()
    expect(node?.review).toBeUndefined()
    expect(node?.lastStudiedAt).toBeUndefined()
  })

  it('carries the new fields through', () => {
    const node = normalizeNode({
      ...base,
      kind: 'review',
      mastery: { score: 88, updatedAt: 9 },
      review: {
        card: {
          due: 10,
          stability: 1,
          difficulty: 1,
          scheduledDays: 1,
          learningSteps: 0,
          reps: 1,
          lapses: 0,
          state: 'learning',
        },
      },
      lastStudiedAt: 8,
    })

    expect(node?.kind).toBe('review')
    expect(node?.mastery?.score).toBe(88)
    expect(node?.review?.card.state).toBe('learning')
    expect(node?.lastStudiedAt).toBe(8)
  })

  it('degrades broken new fields to defaults instead of throwing', () => {
    const node = normalizeNode({
      ...base,
      kind: 'exam',
      mastery: { score: NaN, updatedAt: 1 },
      review: { card: { due: 'later' } },
      lastStudiedAt: 'yesterday',
    })

    expect(node?.kind).toBeUndefined()
    expect(node?.mastery).toBeUndefined()
    expect(node?.review).toBeUndefined()
    expect(node?.lastStudiedAt).toBeUndefined()
  })

  it('repairs missing title/status/timestamps', () => {
    const node = normalizeNode({ id: 'n1', projectId: 'p1' })

    expect(node?.title).toBe('未命名节点')
    expect(node?.status).toBe('active')
    expect(typeof node?.createdAt).toBe('number')
  })

  it('rejects records without id or projectId', () => {
    expect(normalizeNode({ projectId: 'p1' })).toBeNull()
    expect(normalizeNode({ id: 'n1' })).toBeNull()
    expect(normalizeNode(null)).toBeNull()
  })
})

describe('normalizeNote', () => {
  const base = {
    id: 'note-1',
    projectId: 'p1',
    nodeId: 'n1',
    messageId: 'm1',
    labels: ['key'],
    quote: '特征值',
    start: 4,
    end: 7,
    body: '这里是重点',
    createdAt: 10,
    updatedAt: 11,
  }

  it('keeps well-formed records intact', () => {
    expect(normalizeNote(base)).toEqual(base)
  })

  it('clamps broken anchors instead of letting them reach the renderer', () => {
    // 负的起点、倒置的区间都会让渲染期的 Range 直接抛错
    const negative = normalizeNote({ ...base, start: -5, end: -1 })
    expect(negative?.start).toBe(0)
    expect(negative?.end).toBe(0)

    const inverted = normalizeNote({ ...base, start: 9, end: 2, quote: '特征值' })
    expect(inverted?.start).toBe(9)
    expect(inverted?.end).toBe(9)

    const missing = normalizeNote({ ...base, start: undefined, end: undefined })
    expect(missing?.start).toBe(0)
    expect(missing?.end).toBe(3)
  })

  it('reads old records as unlabeled highlights without losing their body', () => {
    // 老数据只有 kind：annotation + body 读出来是「无标签 + 备注保留」，
    // highlight 读出来是纯高亮 —— 两者都不再声称自己带语义标签
    const annotation = normalizeNote({
      id: 'n-old',
      projectId: 'p1',
      nodeId: 'n1',
      messageId: 'm1',
      kind: 'annotation',
      quote: '特征值',
      start: 0,
      end: 3,
      body: '当时抄下来的解释',
      createdAt: 1,
      updatedAt: 1,
    })
    expect(annotation).toMatchObject({ labels: [], body: '当时抄下来的解释' })

    const highlight = normalizeNote({
      id: 'n-old2',
      projectId: 'p1',
      nodeId: 'n1',
      messageId: 'm1',
      kind: 'highlight',
      quote: '特征值',
      start: 0,
      end: 3,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(highlight?.labels).toEqual([])
    expect(highlight?.body).toBeUndefined()
  })

  it('normalizes labels: trims, drops blanks, dedupes and caps the count', () => {
    expect(normalizeNote({ ...base, labels: ['  错题  ', '', '错题', 42] })?.labels).toEqual(['错题'])
    expect(
      normalizeNote({ ...base, labels: ['a', 'b', 'c', 'd', 'e', 'f'] })?.labels,
    ).toHaveLength(4)
    expect(normalizeNote({ ...base, labels: 'mistake' })?.labels).toEqual([])
  })

  it('caps the body length', () => {
    const long = normalizeNote({ ...base, body: 'x'.repeat(500) })
    expect(long?.body).toHaveLength(200)
    expect(normalizeNote({ ...base, body: '   ' })?.body).toBeUndefined()
  })

  it('drops records that cannot be attached to a message', () => {
    expect(normalizeNote({ ...base, messageId: '' })).toBeNull()
    expect(normalizeNote({ ...base, nodeId: undefined })).toBeNull()
    expect(normalizeNote({ ...base, projectId: null })).toBeNull()
    expect(normalizeNote(null)).toBeNull()
  })
})
