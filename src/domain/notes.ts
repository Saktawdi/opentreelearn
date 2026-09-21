import type { Note, NoteKind } from './models'

/** 笔记在正文纯文本里的字符区间 `[start, end)`。 */
export interface Anchor {
  start: number
  end: number
}

export interface SelectionAnchor extends Anchor {
  quote: string
}

export const NOTE_KINDS: readonly NoteKind[] = ['highlight', 'annotation']

export function isNoteKind(value: unknown): value is NoteKind {
  return value === 'highlight' || value === 'annotation'
}

export function noteKindLabel(kind: NoteKind): string {
  return kind === 'highlight' ? '高亮' : '注释'
}

/**
 * 把一次框选换算成笔记锚点。
 *
 * `start` 是选区起点在正文纯文本里的下标，而用户想记下来的那段文字不该带首尾空白
 * （框选很容易多拖半个空格或一个换行），所以按 trim 后的结果收窄区间。终点由
 * `quote.length` 推出而不是另传一个 end：三个口径（选区文本、字符下标、渲染时还原的
 * 区间）必须完全一致，与其逐个校验，不如让它们只可能来自同一个长度。
 */
export function selectionAnchor(raw: string, start: number): SelectionAnchor | null {
  const lead = raw.length - raw.trimStart().length
  const quote = raw.trim()
  if (!quote) return null
  const anchoredStart = start + lead
  return { quote, start: anchoredStart, end: anchoredStart + quote.length }
}

export function sameAnchor(a: Anchor, b: Anchor): boolean {
  return a.start === b.start && a.end === b.end
}

export function anchorOverlaps(a: Anchor, b: Anchor): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * 锚点自愈：渲染结果变了（代码块异步高亮、KaTeX 重排、内容被编辑过）时，
 * 用存下来的原文在正文里就近重新定位 —— 取与提示位置距离最近的一次出现，
 * 同一段文字在正文里出现多次时才不会跳到第一处。找不到就返回 null（笔记失效）。
 */
export function locateQuote(text: string, quote: string, hint: number): Anchor | null {
  if (!quote) return null

  let best: Anchor | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let from = text.indexOf(quote)

  while (from !== -1) {
    const distance = Math.abs(from - hint)
    if (distance < bestDistance) {
      bestDistance = distance
      best = { start: from, end: from + quote.length }
    }
    from = text.indexOf(quote, from + 1)
  }

  return best
}

/** 同一段文字可能既被高亮又有批注：按出现位置排序，笔记条读起来才顺着正文。 */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.start - b.start || a.createdAt - b.createdAt)
}
