import type { Note, NoteLabel } from './models'

/** 标注在正文纯文本里的字符区间 `[start, end)`。 */
export interface Anchor {
  start: number
  end: number
}

export interface SelectionAnchor extends Anchor {
  quote: string
}

/** 备注长度上限：备注默认不进 AI 上下文，但它会进导出与展示，仍要有个头。 */
export const NOTE_BODY_MAX = 200

/** 一条标注最多带几个标签：标签是语义开关，不是分类学作业。 */
export const MAX_NOTE_LABELS = 4

/** 单个标签名（含项目级扩展）的长度上限。 */
export const NOTE_LABEL_MAX = 16

export interface NoteLabelDef {
  id: NoteLabel
  /** 展示名（界面与 AI 上下文里都用它） */
  name: string
  /** 一句释义 —— 没有它，模型只能猜这个标签是什么意思 */
  hint: string
}

/**
 * 内置标签。
 *
 * 这四个覆盖「用户想告诉 AI 的判断」这一层语义：做错了 / 没懂 / 是重点 / 是例题。
 * 它们与渲染无关（旧模型里的 highlight / annotation 只是「有没有写 body」的渲染差异），
 * 是**选择性暴露**的开关：带标签的标注才进 AI 上下文，纯高亮是用户自己的书签。
 */
export const NOTE_LABELS: readonly NoteLabelDef[] = [
  { id: 'mistake', name: '错题', hint: '学习者确认自己做错或答错的内容' },
  { id: 'confusing', name: '没懂', hint: '学习者明确表示没有理解的地方' },
  { id: 'key', name: '关键', hint: '关键结论或核心定义，值得反复回看' },
  { id: 'example', name: '例题', hint: '典型例题或可迁移的解法' },
]

export function isBuiltinNoteLabel(value: unknown): boolean {
  return typeof value === 'string' && NOTE_LABELS.some((entry) => entry.id === value)
}

/** 标签的展示名：内置给中文名，项目级扩展原样返回（它们自带语义）。 */
export function noteLabelName(label: NoteLabel): string {
  return NOTE_LABELS.find((entry) => entry.id === label)?.name ?? label
}

export function noteLabelHint(label: NoteLabel): string | undefined {
  return NOTE_LABELS.find((entry) => entry.id === label)?.hint
}

/** 单个标签：去空白、限长；空串与超长噪声一律丢掉。 */
export function normalizeNoteLabel(value: unknown): NoteLabel | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, NOTE_LABEL_MAX)
  return trimmed.length > 0 ? trimmed : null
}

/** 标签数组：去重、保序、丢空、截断到上限。 */
export function normalizeNoteLabels(value: unknown): NoteLabel[] {
  if (!Array.isArray(value)) return []
  const result: NoteLabel[] = []
  for (const item of value) {
    const label = normalizeNoteLabel(item)
    if (!label || result.includes(label)) continue
    result.push(label)
    if (result.length === MAX_NOTE_LABELS) break
  }
  return result
}

/** 备注：去空白、限长；空串视为没有备注。 */
export function normalizeNoteBody(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, NOTE_BODY_MAX)
  return trimmed.length > 0 ? trimmed : undefined
}

/** 纯高亮（书签）：没有任何标签。 */
export function isPlainHighlight(note: Note): boolean {
  return note.labels.length === 0
}

/** 只取带标签的标注 —— 进 AI 上下文、进复习材料、进工具返回的一律是这一批。 */
export function labeledNotes(notes: Note[]): Note[] {
  return notes.filter((note) => note.labels.length > 0)
}

/** 标签的展示形态：`[错题][没懂]`。 */
export function formatNoteLabels(labels: NoteLabel[]): string {
  return labels.map((label) => `[${noteLabelName(label)}]`).join('')
}

/** 项目里出现过的标签（按首次出现顺序）—— 打标签时提示用，也让模型知道有哪些在用。 */
export function collectUsedLabels(notes: Note[]): NoteLabel[] {
  const used: NoteLabel[] = []
  for (const note of notes) {
    for (const label of note.labels) {
      if (!used.includes(label)) used.push(label)
    }
  }
  return used
}

/** 标签计数：`[错题] 1 · [没懂] 1` —— 让模型一眼看出各有多少条，不必逐条数。 */
export function countNoteLabels(notes: Note[]): string {
  const counts = new Map<NoteLabel, number>()
  for (const note of notes) {
    for (const label of note.labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => `[${noteLabelName(label)}] ${count}`)
    .join(' · ')
}

/**
 * 「用户标注的读法」：标签释义 + 暴露规则。
 *
 * 复习材料与自由问答共用同一份口径 —— 两处各写一套，模型换个入口就会换一套理解。
 * 释义只列**用到的**标签，没出现过的标签不必占上下文。
 */
export function renderNoteLegend(usedLabels: NoteLabel[]): string {
  const lines = ['## 用户标注的读法']
  if (usedLabels.length === 0) {
    lines.push('- 这名学习者还没有打过标签的标注。')
  } else {
    const glossary = usedLabels
      .map((label) => {
        const hint = noteLabelHint(label)
        return hint ? `「${noteLabelName(label)}」= ${hint}` : null
      })
      .filter((line): line is string => line !== null)
    if (glossary.length > 0) lines.push(`- ${glossary.join('；')}。`)
    lines.push(
      '- 这些是**学习者本人的判断**，比从对话里推断出的薄弱点更可信：出题与点评要优先照顾。',
    )
    lines.push(
      '- 只有带标签的标注会给你。不带标签的高亮是他自己的书签，不要询问，也不要推测其含义。',
    )
  }
  return lines.join('\n')
}

/**
 * 把一次框选换算成标注锚点。
 *
 * 输入是选区在**源文**里的 `[start, end)`（DOM 侧换算见 features/chat/note-anchor.ts），
 * 而用户想记下来的那段文字不该带首尾空白（框选很容易多拖半个空格或一个换行），
 * 所以按 trim 后的结果收窄区间。终点由 `quote.length` 推出而不是用选区终点：
 * 三个口径（选区文字、字符下标、渲染时还原的区间）必须完全一致，与其逐个校验，
 * 不如让它们只可能来自同一个长度。
 */
export function selectionAnchorSpan(source: string, start: number, end: number): SelectionAnchor | null {
  const raw = source.slice(start, end)
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

/** 同一段文字可能被标了多次：按出现位置排序，笔记条读起来才顺着正文。 */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.start - b.start || a.createdAt - b.createdAt)
}