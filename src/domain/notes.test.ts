import { describe, expect, it } from 'vitest'
import type { Note } from './models'
import {
  anchorOverlaps,
  collectUsedLabels,
  countNoteLabels,
  formatNoteLabels,
  isPlainHighlight,
  labeledNotes,
  locateQuote,
  NOTE_LABEL_MAX,
  normalizeNoteLabel,
  normalizeNoteLabels,
  noteLabelName,
  renderNoteLegend,
  sameAnchor,
  selectionAnchorSpan,
  sortNotes,
} from './notes'

describe('selectionAnchorSpan', () => {
  it('narrows the range onto the trimmed text', () => {
    // 源文里第 10 到 15 个字符是「 特征值 」：两侧空白不该进锚点
    const source = '0123456789 特征值 尾'
    expect(selectionAnchorSpan(source, 10, 15)).toEqual({ quote: '特征值', start: 11, end: 14 })
  })

  it('keeps the anchor self-consistent for multi-line selections', () => {
    const source = '前文第一行\n第二行\n尾部'
    const anchor = selectionAnchorSpan(source, 2, 9)

    expect(anchor).toEqual({ quote: '第一行\n第二行', start: 2, end: 9 })
    expect(anchor!.end - anchor!.start).toBe(anchor!.quote.length)
  })

  it('keeps the LaTeX source intact (公式不被打平)', () => {
    const source = '面积为 $A$，体积 $V = \\frac{2}{3}\\pi r^3$。'
    const start = source.indexOf('$V')
    const anchor = selectionAnchorSpan(source, start, start + '$V = \\frac{2}{3}\\pi r^3$'.length)

    expect(anchor?.quote).toBe('$V = \\frac{2}{3}\\pi r^3$')
  })

  it('refuses blank selections', () => {
    expect(selectionAnchorSpan('   \n 尾', 0, 5)).toBeNull()
    expect(selectionAnchorSpan('正文', 1, 1)).toBeNull()
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
    labels: [],
    quote: id,
    start,
    end,
    createdAt,
    updatedAt: createdAt,
  }
}

describe('note labels', () => {
  it('normalizes a label: trims, caps length, drops blanks', () => {
    expect(normalizeNoteLabel('  错题 ')).toBe('错题')
    expect(normalizeNoteLabel('')).toBeNull()
    expect(normalizeNoteLabel('   ')).toBeNull()
    expect(normalizeNoteLabel(42)).toBeNull()
    expect(normalizeNoteLabel('x'.repeat(50))).toHaveLength(NOTE_LABEL_MAX)
  })

  it('normalizes a label list: dedupe, order kept, capped', () => {
    expect(normalizeNoteLabels(['b', 'a', 'b', '  ', 'c', 'd', 'e'])).toEqual(['b', 'a', 'c', 'd'])
    expect(normalizeNoteLabels(undefined)).toEqual([])
    expect(normalizeNoteLabels('mistake')).toEqual([])
  })

  it('treats notes without labels as plain highlights and filters them out', () => {
    const plain = makeNote('plain', 0, 3, 1)
    const labeled = { ...makeNote('labeled', 4, 7, 2), labels: ['mistake'] }

    expect(isPlainHighlight(plain)).toBe(true)
    expect(isPlainHighlight(labeled)).toBe(false)
    expect(labeledNotes([plain, labeled]).map((note) => note.id)).toEqual(['labeled'])
  })

  it('renders labels with their built-in Chinese names', () => {
    expect(noteLabelName('mistake')).toBe('错题')
    expect(noteLabelName('项目自定义')).toBe('项目自定义')
    expect(formatNoteLabels(['mistake', 'confusing'])).toBe('[错题][没懂]')
    expect(formatNoteLabels([])).toBe('')
  })

  it('collects used labels in first-seen order and counts them', () => {
    const notes = [
      { ...makeNote('a', 0, 1, 1), labels: ['confusing', 'mistake'] },
      { ...makeNote('b', 2, 3, 2), labels: ['mistake'] },
    ]
    expect(collectUsedLabels(notes)).toEqual(['confusing', 'mistake'])
    expect(countNoteLabels(notes)).toBe('[没懂] 1 · [错题] 2')
  })

  it('renders a legend that only explains the labels actually in use', () => {
    const legend = renderNoteLegend(['mistake'])
    expect(legend).toContain('## 用户标注的读法')
    expect(legend).toContain('「错题」= 学习者确认自己做错或答错的内容')
    expect(legend).not.toContain('没懂')
    // 暴露规则必须写清：不带标签的高亮不外送，模型不该去猜
    expect(legend).toContain('只有带标签的标注会给你')

    expect(renderNoteLegend([])).toContain('还没有打过标签的标注')
  })
})
