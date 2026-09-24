import type { Id, Note } from '@/domain/models'
import { locateQuote, type Anchor } from '@/domain/notes'
import { EXACT_ATTR, SRC_ATTR, parseSourceAttr, type SourceUnit } from '@/lib/markdown/source-map'

/**
 * 笔记锚点的 DOM 侧。
 *
 * 锚点说的是「**源文**里的第 start 到 end 个字符」—— 源文是喂给 Markdown 渲染的那串原文，
 * 也就是模型输出的原样（见 lib/markdown/source-map.ts 里为什么不能拿渲染后的文字当坐标）。
 * 于是进出两个方向各要一套换算：
 *
 *  - 框选那一刻：Range 端点 → 源文下标（`sourceOffsetAt`）；
 *  - 渲染笔记时：源文下标 → 新的 Range（`rangeFromSource`）。
 *
 * 两侧都按**源文标注单位**（`data-otl-src`）来对齐：精确单位按字符偏移算，
 * 公式 / 代码 / 图片这类原子单位整段吸附 —— 宁可粗，也不要错位。
 *
 * 源文本身不落在 DOM 上，由渲染正文的组件登记进来（`registerMessageSource`）。
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

/**
 * 写在正文元素上的源文区间。用户气泡的引用 / 正文是直接渲染的（不走 Markdown），
 * 它们的可标注单位由 JSX 自己标注，口径与 rehype 插件一致，所以在这里给出同一套属性。
 */
export function sourceSpanProps(
  span: { start: number; end: number },
  exact = false,
): Record<string, string> {
  return {
    [SRC_ATTR]: `${span.start},${span.end}`,
    ...(exact ? { [EXACT_ATTR]: '1' } : {}),
  }
}

/* -------------------------------------------------------------- 源文登记表
 * 锚点要两端对齐，缺了源文就没法把「第 n 个字符」落到 DOM 上；而正文是 Markdown
 * 渲染出来的，源文只在 React 组件手里。按 messageId 登记，随消息卸载清掉。
 */

const sources = new Map<Id, string>()

export function registerMessageSource(messageId: Id, source: string): void {
  sources.set(messageId, source)
}

export function releaseMessageSource(messageId: Id): void {
  sources.delete(messageId)
}

/** 这条消息的源文；没有登记（例如正文不在屏上）时返回 null。 */
export function registeredSource(messageId: Id): string | null {
  return sources.get(messageId) ?? null
}

/* ------------------------------------------------------------ 标注单位遍历 */

interface Unit {
  element: Element
  span: SourceUnit
}

function readUnit(element: Element): Unit | null {
  const span = parseSourceAttr(
    element.getAttribute(SRC_ATTR),
    element.getAttribute(EXACT_ATTR) === '1',
  )
  return span ? { element, span } : null
}

/** 正文里的全部标注单位，按文档序（querySelectorAll 就是文档序）。 */
function collectUnits(root: Element): Unit[] {
  const units: Unit[] = []
  for (const element of root.querySelectorAll(`[${SRC_ATTR}]`)) {
    const unit = readUnit(element)
    if (unit) units.push(unit)
  }
  return units
}

/** 端点所属的最近标注单位；落在没标注的合成节点上时返回 null。 */
function unitAt(node: Node | null, root: Element): Element | null {
  let element = node instanceof Element ? node : (node?.parentElement ?? null)
  while (element) {
    if (element.hasAttribute(SRC_ATTR)) return element
    if (element === root) return null
    element = element.parentElement
  }
  return null
}

function isText(node: Node | null): node is Text {
  return node !== null && node.nodeType === Node.TEXT_NODE
}

/** 子树里第一个 / 最后一个文字节点；没有文字（图片等）返回 null。 */
function edgeText(node: Node, edge: 'first' | 'last'): { node: Text; offset: number } | null {
  if (isText(node)) {
    return { node, offset: edge === 'first' ? 0 : (node.nodeValue ?? '').length }
  }
  if (!node.childNodes.length) return null

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let found: Text | null = null
  let current = walker.nextNode()
  while (current) {
    found = current as Text
    if (edge === 'first') break
    current = walker.nextNode()
  }
  return found ? { node: found, offset: edge === 'first' ? 0 : (found.nodeValue ?? '').length } : null
}

/**
 * 把选区端点换算成文字位置。
 *
 * 浏览器多半直接给文字节点，但「拖选整块」时端点会落在元素上（offset 是子节点下标）。
 * 那时按方向找相邻的文字：起点向后找、终点向前找，与「端点贴着块的哪一侧」一致。
 */
function textPoint(container: Node, offset: number, side: 'start' | 'end'): { node: Text; offset: number } | null {
  if (isText(container)) return { node: container, offset }

  const children = container.childNodes
  const from = side === 'start' ? Math.max(0, Math.min(offset, children.length)) : Math.min(offset, children.length) - 1
  const step = side === 'start' ? 1 : -1

  for (let index = from; index >= 0 && index < children.length; index += step) {
    const found = edgeText(children[index] as Node, side === 'start' ? 'first' : 'last')
    if (found) return found
  }
  // 这一侧没有文字（例如块末尾的图片）：反向再找一次
  const back = side === 'start' ? children.length - 1 : 0
  for (let index = back; index >= 0 && index < children.length; index += -step) {
    const found = edgeText(children[index] as Node, side === 'start' ? 'last' : 'first')
    if (found) return found
  }
  return null
}

/** 与点位相邻的标注单位：没落在任何单位里时，按文档序就近取一个。 */
function neighbourUnit(
  root: Element,
  point: { node: Text; offset: number },
  side: 'start' | 'end',
): Unit | null {
  const units = collectUnits(root)
  const follows = (unit: Unit) =>
    (point.node.compareDocumentPosition(unit.element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  // 起点落在没标注的空隙里：向后取第一个单位，把空隙并进选区
  if (side === 'start') return units.find(follows) ?? null

  let found: Unit | null = null
  for (const unit of units) {
    if (!follows(unit)) found = unit
  }
  return found
}

/** 单位内全部文本按文档序拼起来（代码高亮会把一行切成许多 span，字符仍连续）。 */
function unitText(unit: Element): string {
  const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT)
  let text = ''
  let node = walker.nextNode()
  while (node) {
    text += node.nodeValue ?? ''
    node = walker.nextNode()
  }
  return text
}

/** 单位内某个文字位置的**单位内**偏移；不在这个单位里就返回 null。 */
function offsetInUnitText(unit: Element, node: Text, offset: number): number | null {
  const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT)
  let total = 0
  let current = walker.nextNode()
  while (current) {
    if (current === node) return total + offset
    total += current.nodeValue?.length ?? 0
    current = walker.nextNode()
  }
  return null
}

/** 单位内偏移 → 具体的文字位置（与 `offsetInUnitText` 互逆）。 */
function textPointInUnit(unit: Element, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT)
  let total = 0
  let node = walker.nextNode() as Text | null
  let last: Text | null = null

  while (node) {
    const length = node.nodeValue?.length ?? 0
    if (offset <= total + length) return { node, offset: Math.max(0, offset - total) }
    total += length
    last = node
    node = walker.nextNode() as Text | null
  }
  return last ? { node: last, offset: last.nodeValue?.length ?? 0 } : null
}

/**
 * 精确单位是否仍然对得上源文。正文的 DOM 会自己变（代码块异步高亮、字体加载后重排），
 * 对不上就当原子单位整段吸附 —— **宁可粗，也不要给出错位的下标**。
 */
function exactUnitText(unit: Element, span: SourceUnit, source: string): boolean {
  return span.exact && unitText(unit) === source.slice(span.start, span.end)
}

/**
 * 精确单位里按字符偏移对齐（单位文字已核对与源文一致）；原子单位整段 ——
 * 起点取单位头、终点取单位尾，部分落在公式里也扩成整段公式（记全比记错好）。
 */
export function sourceOffsetAt(
  root: Element,
  container: Node,
  offset: number,
  side: 'start' | 'end',
  source: string,
): number | null {
  const point = textPoint(container, offset, side)
  if (!point) return null

  const unit = unitAt(point.node, root)
  if (!unit) {
    const fallback = neighbourUnit(root, point, side)
    if (!fallback) return null
    return side === 'start' ? fallback.span.start : fallback.span.end
  }

  const parsed = readUnit(unit)
  if (!parsed) return null

  if (exactUnitText(unit, parsed.span, source)) {
    const inner = offsetInUnitText(unit, point.node, point.offset)
    if (inner !== null) {
      const at = parsed.span.start + inner
      return Math.min(Math.max(at, parsed.span.start), parsed.span.end)
    }
  }
  // 原子单位、或精确单位已经对不上源文（正文变了）：整段吸附
  return side === 'start' ? parsed.span.start : parsed.span.end
}

/** 选区 → 源文区间；两端有一端对不上就返回 null（宁可不记，也不记一条错位的）。 */
export function selectionSourceSpan(root: Element, range: Range, source: string): Anchor | null {
  const start = sourceOffsetAt(root, range.startContainer, range.startOffset, 'start', source)
  const end = sourceOffsetAt(root, range.endContainer, range.endOffset, 'end', source)
  if (start === null || end === null) return null
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/** 源文下标 → Range 端点：精确单位按偏移切，原子单位取整段的头 / 尾。 */
function boundary(
  unit: Unit,
  offset: number,
  side: 'start' | 'end',
  source: string,
): { node: Node; offset: number } | null {
  if (exactUnitText(unit.element, unit.span, source)) {
    const inner = textPointInUnit(unit.element, offset - unit.span.start)
    if (inner) return inner
  }

  const text = edgeText(unit.element, side === 'start' ? 'first' : 'last')
  if (text) return text
  return side === 'start'
    ? { node: unit.element, offset: 0 }
    : { node: unit.element, offset: unit.element.childNodes.length }
}

/** 源文区间 → Range：与区间相交的第一 / 最后一个标注单位定出两端。 */
export function rangeFromSource(root: Element, start: number, end: number, source: string): Range | null {
  let first: Unit | null = null
  let last: Unit | null = null

  for (const unit of collectUnits(root)) {
    if (unit.span.end <= start) continue
    if (unit.span.start >= end) break
    if (!first) first = unit
    last = unit
  }
  if (!first || !last) return null

  const head = boundary(first, start, 'start', source)
  const tail = boundary(last, end, 'end', source)
  if (!head || !tail) return null

  const range = document.createRange()
  range.setStart(head.node, head.offset)
  range.setEnd(tail.node, tail.offset)
  return range
}

export interface ResolvedRange {
  range: Range
  /** 这段笔记当前实际落在哪里：自愈过的话与存下来的区间不同。 */
  anchor: Anchor
}

/**
 * 笔记 → 当前渲染结果里的 Range。
 *
 * 先按存下来的源文区间定位；定位到的区间**逐字等于** `quote` 就直接用 —— 不等说明
 * 正文变了（消息被改过、模型重答过）或这条笔记来自旧版本（那时记的是渲染后的文字，
 * 公式已经是 `r2=2a2cos2θ` 这种字形），退回「用原文在源文里就近找一次」。
 * 两者都失败就是彻底失效：返回 null，笔记仍留在笔记条里可读可删。
 */
export function resolveNoteRange(note: Note): ResolvedRange | null {
  const root = bodyElement(note.messageId)
  if (!root) return null

  const source = registeredSource(note.messageId)
  if (source === null) return null

  const stored: Anchor = { start: note.start, end: note.end }

  const exact = rangeFromSource(root, stored.start, stored.end, source)
  if (exact && source.slice(stored.start, stored.end) === note.quote) {
    return { range: exact, anchor: stored }
  }

  const located = locateQuote(source, note.quote, note.start)
  if (!located) return null

  const healed = rangeFromSource(root, located.start, located.end, source)
  return healed ? { range: healed, anchor: located } : null
}

/* ------------------------------------------------------------------ 高亮登记
 * 用 CSS Custom Highlight API 画高亮：往 Range 注册表里登记区间，由浏览器负责上色。
 * 之所以不往正文里包 <mark>：正文是 React 渲染出来的，凭空插节点会和 diff 打架，
 * 而注册表完全不碰 DOM —— 重渲染后重新登记一次即可。
 */

const PLAIN_NAME = 'otl-note-highlight'
const LABELED_NAME = 'otl-note-annotation'

const FOCUS_NAME = 'otl-note-focus'

export function supportsNoteHighlight(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

export interface RegisteredRange {
  /** 带标签的标注与纯高亮用两套配色：前者是「给 AI 的信号」，后者是自己的书签 */
  labeled: boolean
  range: Range
}

/** 每个消息气泡以自己的 key 登记区间；任何一次变动都整体重建两个具名高亮。 */
const registrations = new Map<string, RegisteredRange[]>()

function rebuild(): void {
  if (!supportsNoteHighlight()) return

  for (const labeled of [false, true] as const) {
    const ranges = [...registrations.values()]
      .flat()
      .filter((entry) => entry.labeled === labeled)
      .map((entry) => entry.range)
    const name = labeled ? LABELED_NAME : PLAIN_NAME

    if (ranges.length > 0) {
      CSS.highlights.set(name, new Highlight(...ranges))
    } else {
      CSS.highlights.delete(name)
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
