import { describe, expect, it } from 'vitest'
import {
  effectiveReasoningEffort,
  isValidReasoningLevel,
  matchModel,
  reasoningCandidatesFor,
  unionReasoningCandidates,
  type ModelCatalogEntries,
} from './model-catalog'

/** 模拟 models.dev 目录结构（reasoning_options 两种形态 + 不支持推理 + 超集档位 max）。 */
const entries: ModelCatalogEntries = {
  'deepseek-ai/DeepSeek-V4-Pro': {
    id: 'deepseek-ai/DeepSeek-V4-Pro',
    reasoning: true,
    reasoning_options: [
      { type: 'toggle' },
      { type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] },
    ],
  },
  'deepseek-ai/deepseek-chat': {
    id: 'deepseek-ai/deepseek-chat',
    reasoning: false,
  },
  'openai/gpt-5.1-chat-latest': {
    id: 'openai/gpt-5.1-chat-latest',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  },
  'anthropic/claude-sonnet-4-5': {
    id: 'anthropic/claude-sonnet-4-5',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['high', 'medium', 'low'] }],
  },
  'zhipuai/glm-5.2-old': {
    id: 'zhipuai/glm-5.2-old',
    reasoning: true,
    reasoning_options: [{ type: 'toggle' }],
  },
  'kimi/kimi-k3': {
    id: 'kimi/kimi-k3',
    reasoning: true,
  },
}

describe('matchModel 归一化天梯', () => {
  it('目录完整 id 精确命中', () => {
    const hit = matchModel('deepseek-ai/DeepSeek-V4-Pro', entries)
    expect(hit?.entryId).toBe('deepseek-ai/DeepSeek-V4-Pro')
  })

  it('完整 id 带大小写/点号差异也命中（归一化后相等）', () => {
    expect(matchModel('deepseek-ai/deepseek-v4-pro', entries)?.entryId).toBe(
      'deepseek-ai/DeepSeek-V4-Pro',
    )
  })

  it('网关裸 id 命中目录带厂商段的条目', () => {
    const hit = matchModel('deepseek-chat', entries)
    expect(hit?.entryId).toBe('deepseek-ai/deepseek-chat')
  })

  it('裸 id 带日期戳命中目录 latest 条目（版本尾巴互相剥）', () => {
    const hit = matchModel('gpt-5.1-chat-2025-11-13', entries)
    expect(hit?.entryId).toBe('openai/gpt-5.1-chat-latest')
  })

  it('裸 id 带 latest 直接命中同厂商条目', () => {
    expect(matchModel('gpt-5.1-chat-latest', entries)?.entryId).toBe(
      'openai/gpt-5.1-chat-latest',
    )
  })

  it('跨厂商不借行：glm 的裸 id 不会挂到别的厂商', () => {
    // zhipuai 有 glm-5.2-old 条目：裸 id 应该精确命中它而不是任意猜测
    const hit = matchModel('glm-5.2-old', entries)
    expect(hit?.entryId).toBe('zhipuai/glm-5.2-old')
    // 且不会命中任何 deepseek 条目（严格相等天然防错配）
    expect(hit?.entryId).not.toContain('deepseek')
  })

  it('完全未知的 id 返回 null（退回自由输入）', () => {
    expect(matchModel('llama-99-x', entries)).toBeNull()
    expect(matchModel('', entries)).toBeNull()
  })

  it('目录为空时永远 null', () => {
    expect(matchModel('deepseek-chat', {})).toBeNull()
  })
})

describe('reasoningCandidatesFor 档位提取', () => {
  it('effort values 与合法档位求交（支持 max 等主流大模型档位）', () => {
    const result = reasoningCandidatesFor('gpt-5.1-chat-latest', entries)
    expect(result?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(result?.sourceId).toBe('openai/gpt-5.1-chat-latest')
  })

  it('目录 values 乱序时按固定展示序输出', () => {
    expect(reasoningCandidatesFor('claude-sonnet-4-5', entries)?.levels).toEqual([
      'low',
      'medium',
      'high',
    ])
  })

  it('toggle 型模型只给「关闭」', () => {
    expect(reasoningCandidatesFor('glm-5.2-old', entries)?.levels).toEqual(['none'])
  })

  it('支持推理但没给任何档位：至少给「关闭」', () => {
    expect(reasoningCandidatesFor('kimi-k3', entries)?.levels).toEqual(['none'])
  })

  it('不支持推理的模型返回 null', () => {
    expect(reasoningCandidatesFor('deepseek-chat', entries)).toBeNull()
  })

  it('带 toggle + effort 时两者合并去重', () => {
    expect(reasoningCandidatesFor('DeepSeek-V4-Pro', entries)?.levels).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  it('支持自定义 customConfig 中的 reasoningLevels 优先覆盖', () => {
    const result = reasoningCandidatesFor('gemini-3.8-flash-api', {}, {
      reasoning: true,
      reasoningLevels: ['low', 'high'],
    })
    expect(result?.levels).toEqual(['low', 'high'])
    expect(result?.sourceId).toBe('gemini-3.8-flash-api (自定义)')
  })

  it('未在目录找到且未指定自定义档位，但明确开启 reasoning 时，兜底给出标准候选', () => {
    const result = reasoningCandidatesFor('gemini-3.8-flash-api', {}, {
      reasoning: true,
    })
    expect(result?.levels).toEqual(['none', 'low', 'medium', 'high'])
  })
})

describe('unionReasoningCandidates 多模型合并', () => {
  it('取并集并记录来源，不支持推理的模型被跳过', () => {
    const result = unionReasoningCandidates(['deepseek-chat', 'gpt-5.1-chat-latest'], entries)
    expect(result.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(result.sources.get('xhigh')).toBe('openai/gpt-5.1-chat-latest')
    expect(result.sources.get('max')).toBe('openai/gpt-5.1-chat-latest')
  })

  it('支持合并传入各模型的自定义 modelConfigs', () => {
    const result = unionReasoningCandidates(
      ['gemini-3.8-flash-api'],
      {},
      {
        'gemini-3.8-flash-api': { reasoning: true, reasoningLevels: ['low', 'medium', 'high'] },
      },
    )
    expect(result.levels).toEqual(['low', 'medium', 'high'])
    expect(result.sources.get('low')).toBe('gemini-3.8-flash-api (自定义)')
  })

  it('没有可匹配模型时为空', () => {
    const result = unionReasoningCandidates(['llama-99-x'], entries)
    expect(result.levels).toEqual([])
    expect(result.sources.size).toBe(0)
  })
})

describe('生效值与合法性', () => {
  it('isValidReasoningLevel：8 档合法（含 max），auto/超集值/undefined 非法', () => {
    expect(isValidReasoningLevel('low')).toBe(true)
    expect(isValidReasoningLevel('xhigh')).toBe(true)
    expect(isValidReasoningLevel('max')).toBe(true)
    expect(isValidReasoningLevel('auto')).toBe(false)
    expect(isValidReasoningLevel('invalid_val')).toBe(false)
    expect(isValidReasoningLevel(undefined)).toBe(false)
  })

  it('会话级覆盖优先于提供商配置', () => {
    expect(effectiveReasoningEffort('high', 'low')).toBe('high')
    expect(effectiveReasoningEffort(undefined, 'high')).toBe('high')
  })

  it('覆盖为 auto 时回到提供商配置', () => {
    expect(effectiveReasoningEffort('auto', 'low')).toBe('low')
  })

  it('双方都没有/非法值时返回 undefined（不传参）', () => {
    expect(effectiveReasoningEffort('auto', 'auto')).toBeUndefined()
    expect(effectiveReasoningEffort(undefined, 'invalid_val')).toBeUndefined()
    expect(effectiveReasoningEffort(undefined, undefined)).toBeUndefined()
  })
})