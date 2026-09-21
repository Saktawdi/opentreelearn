import { describe, expect, it } from 'vitest'
import type { Note } from './models'
import { anchorOverlaps, locateQuote, sameAnchor, selectionAnchor, sortNotes } from './notes'

describe('selectionAnchor', () => {
  it('narrows the range onto the trimmed text', () => {
    // 选区从正文第 10 个字符开始，内容是「 特征值 」：两侧空白不该进锚点
    expect(selectionAnchor(' 特征值 ', 10)).toEqual({ quote: '特征值', start: 11, end: 14 })
  })

  it('keeps the anchor self-consistent for multi-line selections', () => {
    const raw = '第一行\n第二行\n'
    const anchor = selectionAnchor(raw, 3)

    expect(anchor).toEqual({ quote: '第一行\n第二行', start: 3, end: 10 })
    expect(anchor!.end - anchor!.start).toBe(anchor!.quote.length)
  })

  it('refuses blank selections', () => {
    expect(selectionAnchor('   \n ', 5)).toBeNull()
    expect(selectionAnchor('', 0)).toBeNull()
  })
})

describe('locateQuote', () => {
  const text = '特征值就是 λ；求特征值要先解方程'

  it('picks the occurrence closest to the hint', () => {
    const second = text.indexOf('特征值', 1)

    expect(locateQuote(text, '特征值', 0)).toEqual({ start: 0, end: 3 })
    expect(locateQuote(text, '特征值', second)).toEqual({ start: second, end: second + 3 })
  })

  it('returns null when the quote is no longer in the text', () => {
    expect(locateQuote('完全不同的正文', '特征值', 0)).toBeNull()
    expect(locateQuote(text, '', 0)).toBeNull()
  })
})

describe('anchors', () => {
  it('compares ranges by position', () => {
    expect(sameAnchor({ start: 2, end: 5 }, { start: 2, end: 5 })).toBe(true)
    expect(sameAnchor({ start: 2, end: 5 }, { start: 2, end: 6 })).toBe(false)
  })

  it('treats touching ranges as disjoint', () => {
    expect(anchorOverlaps({ start: 0, end: 3 }, { start: 2, end: 6 })).toBe(true)
    expect(anchorOverlaps({ start: 0, end: 3 }, { start: 3, end: 6 })).toBe(false)
  })
})

describe('sortNotes', () => {
  it('orders notes by where they appear in the message', () => {
    const notes = [
      makeNote('c', 8, 12, 30),
      makeNote('a', 2, 5, 20),
      makeNote('b', 2, 5, 10),
    ]

    expect(sortNotes(notes).map((note) => note.id)).toEqual(['b', 'a', 'c'])
  })
})

function makeNote(id: string, start: number, end: number, createdAt: number): Note {
  return {
    id,
    projectId: 'p1',
    nodeId: 'n1',
    messageId: 'm1',
    kind: 'highlight',
    quote: id,
    start,
    end,
    createdAt,
    updatedAt: createdAt,
  }
}
