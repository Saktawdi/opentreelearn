import type { Id, Note, NoteKind } from '@/domain/models'
import { locateQuote, NOTE_KINDS, type Anchor } from '@/domain/notes'

/**
 * 笔记锚点的 DOM 侧。
 *
 * 锚点说的是「正文纯文本里的第 start 到 end 个字符」，而选区来自真实 DOM，
 * 所以进出两个方向都要有一套换算：
 *  - 框选那一刻：Range 端点 → 字符下标（`offsetInBody`）；
 *  - 渲染笔记时：字符下标 → 新的 Range（`rangeFromAnchor`）。
 * 两侧都按「正文容器下所有文本节点顺序拼接」这一个口径来数，结果才对得上。
 */

/** 消息正文容器上的标记属性，值是该消息 id；同时用于锚点失效后反查容器。 */
export const BODY_ATTR = 'data-message-body'

/** JSX 里写 `{...bodyProps(message.id)}`：标记名只在上面那一处定义。 */
export function bodyProps(messageId: Id): { 'data-message-body': string } {
  return { [BODY_ATTR]: messageId }
}

export function bodyElement(messageId: Id): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${BODY_ATTR}="${CSS.escape(messageId)}"]`)
}

/** 选区端点 → 正文纯文本里的字符下标。调用前必须确认 container 在 root 之内。 */
export function offsetInBody(root: Element, container: globalThis.Node, offset: number): number {
  const range = document.createRange()
  range.setStart(root, 0)
  range.setEnd(container, offset)
  return range.toString().length
}

/** 字符区间 → Range：沿文本节点累加长度，走到覆盖 `[start, end)` 的两个端点。 */
export function rangeFromAnchor(root: Element, anchor: Anchor): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()

  let position = 0
  let started = false
  let node = walker.nextNode()

  while (node) {
    const length = node.nodeValue?.length ?? 0
    const next = position + length

    if (!started && next >= anchor.start) {
      range.setStart(node, Math.min(length, anchor.start - position))
      started = true
    }
    if (started && next >= anchor.end) {
      range.setEnd(node, Math.min(length, anchor.end - position))
      return range
    }

    position = next
    node = walker.nextNode()
  }

  // 正文比记录时短了（内容被改过 / 渲染有出入），区间落不到实处
  return null
}

export interface ResolvedRange {
  range: Range
  /** 这段笔记当前实际落在哪里：自愈过的话与存下来的区间不同。 */
  anchor: Anchor
}

/**
 * 笔记 → 当前渲染结果里的 Range。
 *
 * 先按存下来的字符区间定位，区间上的文字与 `quote` 对得上就直接用；对不上说明正文
 * 的渲染结果变了（代码块异步高亮、KaTeX 重排、消息被改过），退回「用原文在正文里
 * 就近找一次」。两者都失败就是彻底失效：返回 null，笔记仍留在笔记条里可读可删。
 */
export function resolveNoteRange(note: Note): ResolvedRange | null {
  const root = bodyElement(note.messageId)
  if (!root) return null

  const stored: Anchor = { start: note.start, end: note.end }
  const exact = rangeFromAnchor(root, stored)
  if (exact && exact.toString() === note.quote) return { range: exact, anchor: stored }

  const located = locateQuote(root.textContent ?? '', note.quote, note.start)
  if (!located) return null

  const healed = rangeFromAnchor(root, located)
  return healed ? { range: healed, anchor: located } : null
}

/* ------------------------------------------------------------------ 高亮登记
 * 用 CSS Custom Highlight API 画高亮：往 Range 注册表里登记区间，由浏览器负责上色。
 * 之所以不往正文里包 <mark>：正文是 React 渲染出来的，凭空插节点会和 diff 打架，
 * 而注册表完全不碰 DOM —— 重渲染后重新登记一次即可。
 */

const HIGHLIGHT_NAME: Record<NoteKind, string> = {
  highlight: 'otl-note-highlight',
  annotation: 'otl-note-annotation',
}

const FOCUS_NAME = 'otl-note-focus'

export function supportsNoteHighlight(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

export interface RegisteredRange {
  kind: NoteKind
  range: Range
}

/** 每个消息气泡以自己的 key 登记区间；任何一次变动都整体重建两个具名高亮。 */
const registrations = new Map<string, RegisteredRange[]>()

function rebuild(): void {
  if (!supportsNoteHighlight()) return

  for (const kind of NOTE_KINDS) {
    const ranges = [...registrations.values()]
      .flat()
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.range)

    if (ranges.length > 0) {
      CSS.highlights.set(HIGHLIGHT_NAME[kind], new Highlight(...ranges))
    } else {
      CSS.highlights.delete(HIGHLIGHT_NAME[kind])
    }
  }
}

export function publishNoteRanges(owner: string, entries: RegisteredRange[]): void {
  registrations.set(owner, entries)
  rebuild()
}

export function retractNoteRanges(owner: string): void {
  if (registrations.delete(owner)) rebuild()
}

/** 让一段文字闪一下（点笔记条定位时用），返回提前取消的函数。 */
export function flashRange(range: Range, duration = 1200): () => void {
  if (!supportsNoteHighlight()) return () => {}

  CSS.highlights.set(FOCUS_NAME, new Highlight(range))
  const timer = window.setTimeout(() => CSS.highlights.delete(FOCUS_NAME), duration)

  return () => {
    window.clearTimeout(timer)
    CSS.highlights.delete(FOCUS_NAME)
  }
}

/** 把一条笔记对应的文字滚进视野并闪一下；定位不到就什么都不做。 */
export function revealNote(note: Note): void {
  const resolved = resolveNoteRange(note)
  if (!resolved) return

  const node = resolved.range.startContainer
  const element = node instanceof Element ? node : node.parentElement
  element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flashRange(resolved.range)
}
