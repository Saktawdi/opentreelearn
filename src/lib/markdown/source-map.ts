/**
 * 正文的**源文坐标**标注（Markdown → DOM 的偏移桥）。
 *
 * 为什么需要：正文渲染成 DOM 之后，「DOM 里的文字」与「模型输出的原文」不再一一对应。
 * KaTeX 把 `$r^2=2a^2\cos 2\theta$` 排成上下标字形（DOM 文字是 `r2=2a2cos2θ`）、
 * 反引号与围栏被吃掉、实体与转义被还原 —— 用户框选时读到的 `selection.toString()`
 * 全是这种**排版后的字形**，据此写下的标注 quote 与下标一旦回传到 AI 上下文、
 * 复习材料与写工具，公式就退化成 `r2=2a2cos2θ` 这样的乱码。
 *
 * 所以标注一律记在**源文坐标**（喂给 Markdown 的那串原文）上，而不是 DOM 文字上。
 * 这个插件在渲染前给「标注单位」写进源文区间属性：
 *
 *  - **精确单位**（`data-otl-src="s,e"` + `data-otl-exact="1"`）：单位内的渲染文字
 *    与源文 `[s, e)` 逐字相同，所以单位内第 n 个字就是源文第 s+n 个字符。
 *    普通文字、加粗、链接、行内代码、整段代码都属于这一类 —— 它们的渲染文字都能在
 *    自己的源文切片里**找到**（位置可能偏移，比如行内代码的切片含反引号、表格单元格
 *    的切片含竖线），所以拿 `indexOf` 定出真实区间，而不是照抄位置。
 *  - **原子单位**（只有 `data-otl-src`）：渲染文字与源文对不上或内部不可拆 ——
 *    公式（KaTeX 换成字形）、图片、分隔线、控件。框选落在里面时整段吸附到 `[s, e)`：
 *    宁可粗一点，也不要给出错位的下标。
 *
 * 单位之外的字符（表格竖线、围栏、`**` 这类只存在于源文的标记）不标注，
 * 框选落进空隙时由 DOM 侧就近吸附（见 features/chat/note-anchor.ts）。
 *
 * **公式必须包一层**：KaTeX 会把公式元素整个换成排版结果，属性挂在原元素上会被一起丢掉，
 * 所以用一层 span / div 承住区间。其余元素（含代码块）都**就地**挂属性 —— 多插一层盒子
 * 会给正文排版添麻烦（首尾元素的 margin 归零规则就按 DOM 子元素挑）。
 *
 * 插件必须排在 rehype-katex **之前**（见 MarkdownView 的 rehypePlugins 顺序）。
 */

/**
 * 源文区间的两个名字：hast 里写驼峰属性（`dataOtlSrc`），渲染到 DOM 时才是连字符属性
 * （`data-otl-src`）。这里把两套都摊开写，避免哪一侧改名时另一侧悄悄失联。
 */
export const SRC_PROP = 'dataOtlSrc'
export const EXACT_PROP = 'dataOtlExact'
/** DOM 属性名：`"start,end"`，DOM 侧读 `dataset.otlSrc`。 */
export const SRC_ATTR = 'data-otl-src'
/** DOM 属性名：`"1"` 表示单位内渲染文字与源文逐字对齐。 */
export const EXACT_ATTR = 'data-otl-exact'

/** 内部不可拆、且渲染文字通常与源文对不上的元素：整段锚定。 */
const ATOMIC_TAGS = new Set([
  'img',
  'input',
  'br',
  'hr',
  'iframe',
  'video',
  'audio',
  'canvas',
  'svg',
  'math',
  'object',
  'embed',
])

/** 只用到 hast 里这几样，结构类型本地声明：@types/hast 不是本项目的直接依赖。 */
interface Point {
  offset?: number
}
interface Position {
  start?: Point
  end?: Point
}
export interface MarkdownNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownNode[]
  position?: Position
}

interface Span {
  start: number
  end: number
}

/** 节点在源文里的区间；位置缺失或越界时返回 null（不猜）。 */
function spanOf(node: MarkdownNode, source: string): Span | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number') return null
  if (start < 0 || end < start || end > source.length) return null
  return { start, end }
}

/** `text` 出现在 `[span.start, span.end)` 里的位置；找不到或为空返回 null。 */
function locateText(text: string, span: Span, source: string): Span | null {
  if (!text) return null
  const at = source.slice(span.start, span.end).indexOf(text)
  return at < 0 ? null : { start: span.start + at, end: span.start + at + text.length }
}

function srcProps(span: Span, exact: boolean): Record<string, unknown> {
  return {
    [SRC_PROP]: `${span.start},${span.end}`,
    ...(exact ? { [EXACT_PROP]: '1' } : {}),
  }
}

/** 就地挂区间：元素本身要留在原位时用（代码块、图片、分隔线…）。 */
function annotate(node: MarkdownNode, span: Span, exact: boolean): MarkdownNode {
  node.properties = { ...node.properties, ...srcProps(span, exact) }
  return node
}

/** 包一层承住区间：文字节点没有属性、公式元素会被 KaTeX 整个替换，只能包。 */
function wrapper(tagName: string, span: Span, exact: boolean, child: MarkdownNode): MarkdownNode {
  return {
    type: 'element',
    tagName,
    properties: srcProps(span, exact),
    children: [child],
  }
}

/** 元素上的 className 列表（hast 里可能是数组或字符串）。 */
function classesOf(node: MarkdownNode): string[] {
  const raw = node.properties?.className
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string') return raw.split(/\s+/)
  return []
}

/** 元素本身是不是公式（class 或 tagName）；只认自己，不看子孙。 */
function isMathNode(node: MarkdownNode): boolean {
  if (node.tagName === 'math') return true
  const classes = classesOf(node)
  return (
    classes.includes('language-math') ||
    classes.includes('math-inline') ||
    classes.includes('math-display')
  )
}

/**
 * 行间公式：`<pre><code class="language-math math-display">` —— class 挂在**子元素**上，
 * pre 自己什么都看不出来。漏判会让它掉进代码块分支，属性随 pre 一起被 KaTeX 换掉。
 */
function isMathBlock(node: MarkdownNode): boolean {
  return isMathNode(node) || (node.children ?? []).some(isMathNode)
}

/** 元素下的文字拼接 —— 用来与源文切片对账。 */
function textOf(node: MarkdownNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

function mapNode(node: MarkdownNode, source: string): MarkdownNode[] {
  if (node.type === 'text') {
    const value = node.value ?? ''
    const span = spanOf(node, source)
    if (!span) return [node]
    // 位置有时比 value 宽（行内代码含反引号、实体与转义），按内容定位更准
    const inner = locateText(value, span, source)
    return [
      inner
        ? wrapper('span', inner, true, node)
        : wrapper('span', span, false, node),
    ]
  }

  if (node.type !== 'element') return [node]

  const tagName = node.tagName ?? ''
  const span = spanOf(node, source)

  // 公式：包一层，整段锚定（区间含 $ 定界符，取用时才看得出这是公式）。
  // 行内是 span（KaTeX 只换掉 code 本身），行间是 div（pre 会被整体替换）。
  if (span && isMathNode(node)) {
    return [wrapper('span', span, false, node)]
  }

  if (span && tagName === 'pre') {
    // 行间公式：pre 里裹着带 math class 的 code
    if (isMathBlock(node)) return [wrapper('div', span, false, node)]

    // 代码块：围栏与语言标记不进 DOM，锚到中间那段代码本身；属性就地挂在 pre 上
    // （MarkdownView 会把它们转交给代码容器）
    const code = (node.children ?? []).find((child) => child.tagName === 'code')
    const content = code ? locateText(textOf(code).replace(/\n$/, ''), span, source) : null
    return [annotate(node, content ?? span, content !== null)]
  }

  if (span && ATOMIC_TAGS.has(tagName)) {
    const inner = locateText(textOf(node), span, source)
    return [annotate(node, inner ?? span, inner !== null)]
  }

  const children = node.children
  if (children) {
    node.children = children.flatMap((child) => mapNode(child, source))
  }
  return [node]
}

/**
 * 生成给 react-markdown 用的 rehype 插件：把源文区间标注到单位元素上。
 *
 * `source` 必须是**同一份**交给 Markdown 的字符串（含 normalizeDisplayMath 的结果），
 * 否则位置会整体错位。
 */
export function rehypeSourceMap(source: string) {
  return (tree: MarkdownNode): void => {
    if (!source) return
    if (tree.children) tree.children = tree.children.flatMap((child) => mapNode(child, source))
  }
}

/* ---------------------------------------------------------------- DOM 侧对读 */

export interface SourceUnit {
  /** 精确单位：单位内第 n 个字符 = 源文 start+n */
  exact: boolean
  start: number
  end: number
}

/** 解析 `data-otl-src`；格式不对就当作没标注。 */
export function parseSourceAttr(raw: string | undefined | null, exact: boolean): SourceUnit | null {
  if (!raw) return null
  const [startText, endText] = raw.split(',')
  const start = Number(startText)
  const end = Number(endText)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null
  return { exact, start, end }
}
