import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseTreeFileText, parseTreeJson, TreeParseError } from './tree-file'

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

  it('parses the real .gate file faithfully', () => {
    const text = readFileSync(
      '.gate/chat-files/20260920-192723-byrgemf6k-_______.tree',
      'utf-8',
    )
    const parsed = parseTreeFileText(text)
    expect(parsed.name).toBe('考研数学二章节')
    expect(parsed.stats.cards).toBe(11)
    expect(parsed.stats.roots).toBe(3)
    expect(parsed.stats.messages).toBe(28)
    expect(parsed.stats.skippedMessages).toBe(4)
    expect(parsed.stats.contextSeeds).toBe(8)
  })
})