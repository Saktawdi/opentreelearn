import { describe, expect, it } from 'vitest'
import { createDefaultSettings, DEFAULT_CONTEXT_BUDGET } from './defaults'
import {
  normalizeGlobalSettings,
  normalizeModelRef,
  normalizeNote,
  normalizeProject,
  normalizeProvider,
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

describe('normalizeNote', () => {
  const base = {
    id: 'note-1',
    projectId: 'p1',
    nodeId: 'n1',
    messageId: 'm1',
    kind: 'annotation',
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

  it('falls back to a highlight when the kind is unknown', () => {
    expect(normalizeNote({ ...base, kind: '书签' })?.kind).toBe('highlight')
  })

  it('drops records that cannot be attached to a message', () => {
    expect(normalizeNote({ ...base, messageId: '' })).toBeNull()
    expect(normalizeNote({ ...base, nodeId: undefined })).toBeNull()
    expect(normalizeNote({ ...base, projectId: null })).toBeNull()
    expect(normalizeNote(null)).toBeNull()
  })
})
