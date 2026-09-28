/**
 * 块级公式围栏的渲染前规范化。
 *
 * micromark-extension-math（remark-math 的底层实现）解析 `$$` 块有两条硬规则：
 *
 * 1. 开栏 `$$` 之后**同一行**的内容会被当作围栏元信息（类似代码块的信息串）吞掉，
 *    不进入公式内容；而且这段元信息里一旦出现 `$`，块级解析会直接放弃、退回行内；
 * 2. 闭合围栏必须**整行只有 `$$`**（行首可有空白、行尾只允许空白）；写在内容行尾的
 *    `$$` 只是普通正文字符，永远不闭合。
 *
 * 模型最爱的 cases 写法恰好踩中这两条：`$$I_n = \begin{cases}` 开栏 → `\begin{cases}`
 * 被丢掉，`&` 成了顶层字符（KaTeX 报 `Expected 'EOF', got '&'`）；`\end{cases}$$` 收尾
 * → 公式块一路吞到文末。渲染端配了 `throwOnError: false`，于是整段被吞进来的源码被
 * 原样渲染成一大片红色原始文本。
 *
 * 这里做三件事，都只针对**已闭合的**块级公式：
 *
 * 1. 把两个围栏（含 `>` 引用前缀写法）挪到独占一行；
 * 2. 开栏带缩进（即公式写在列表项里）时，把块内缩进不足开栏缩进的行补齐到该缩进。
 *    这是容器边界的坑：列表项要求续行至少缩进到内容列，`$$` 在项内开栏后，块里任何
 *    一行缩进不足都会把列表项截断 —— 公式块在项内被掐成空块，块后的 `$$` 又开一个
 *    新公式块一路吞到文末，渲染出大片红色原文；
 * 3. 开栏带引用前缀（`> `）时，改写后的每一行都带着同一前缀 —— 引用块里的公式
 *    同样不能被"开栏同行内容 / 行尾闭合"两条硬规则打散。
 *
 * 边界：
 *
 * - 单行 `$$…$$` 与行内 `$…$` 一律原样保留 —— 它们走行内解析，本来就不触发上面两条规则；
 * - 代码围栏（``` / ~~~，含引用前缀写法）内部不动，避免改坏代码示例；
 * - **没找到闭合围栏的块不做任何改写**：流式生成中途的半截公式本来就会被解析器按
 *   文末自动闭合处理，替它补围栏只会把「显示原文」变成「红色报错」，白白更差；
 * - 缩进开栏只认两种：≤ 3 空格（任何位置），或 ≥ 4 空格且落在**当前列表项的内容列**
 *   （模型把公式写在两位编号 / 嵌套列表里都在这列）。顶层 4 空格是缩进代码块，
 *   不在此列；列表项内还要再深 4 格（内容列 +4）同样按代码块处理，不动；
 * - 引用块改写要求块内每一行都带**同一个**引用前缀：有行脱离引用时，块在原文档里
 *   本来就断在中间，改写只会更乱，整块原样放过。
 */

interface DollarRun {
  start: number
  length: number
}

/** `from` 之后第一个长度 ≥ 2 的美元序列；被反斜杠转义的 `\$` 不算围栏。 */
function findDollarRun(text: string, from: number): DollarRun | null {
  let index = from
  while (index < text.length) {
    if (text[index] !== '$') {
      index += 1
      continue
    }
    const end = skipDollars(text, index)
    if (end - index >= 2 && !isEscaped(text, index)) return { start: index, length: end - index }
    index = end
  }
  return null
}

function skipDollars(text: string, start: number): number {
  let end = start
  while (end < text.length && text[end] === '$') end += 1
  return end
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1
  return backslashes % 2 === 1
}

/** 行首的引用前缀（`>`，可嵌套、可带 0-1 个空格）；没有引用的行返回空串。 */
const QUOTE_PREFIX = /^(?: {0,3}> ?)*/

function splitQuote(line: string): { quote: string; body: string } {
  const quote = QUOTE_PREFIX.exec(line)?.[0] ?? ''
  return { quote, body: line.slice(quote.length) }
}

/** 列表标记行（`- ` / `1. ` / `1) `）→ 内容列；不是标记行返回 null。 */
const LIST_MARKER = /^( *)([-*+]|\d{1,9}[.)])( +)/

function listContentColumn(line: string): number | null {
  const match = LIST_MARKER.exec(line)
  if (!match) return null
  const indent = match[1].length
  const marker = match[2].length
  const spaces = match[3].length
  // 标记后 1-4 个空格是内容缩进；更多时空格算内容本身（与 CommonMark 一致地取 1）
  return indent + marker + (spaces <= 4 ? spaces : 1)
}

/** 前导空格不足 `width` 的行补齐到 `width`；tab 开头的行补齐后顶到下一制表位，不影响续行判定。 */
function padToIndent(line: string, width: number): string {
  if (width === 0) return line
  const spaces = /^ */.exec(line)?.[0].length ?? 0
  return spaces >= width ? line : `${' '.repeat(width - spaces)}${line}`
}

/** `\end{cases}$$` 这种「内容 + 行尾 `$$`」：按行内意图应在 `$$` 前断行。 */
function trailingFence(line: string): DollarRun | null {
  const run = findDollarRun(line, 0)
  if (!run) return null
  const head = line.slice(0, run.start)
  // 前面已有别的 `$` 就不是清晰的收尾意图（如单行 `$$…$$` 或行内公式），不猜
  if (head.trim() === '' || head.includes('$')) return null
  if (line.slice(run.start + run.length).trim() !== '') return null
  return run
}

/**
 * 行首（引用前缀之后）的 `$$` 开栏，且开栏行自身不闭合、开栏后不含 `$`。
 *
 * 开栏后含 `$` 的行（`$$E = mc^2$$`）解析器本来就不会按块级处理，必须原样放过，
 * 否则会把一段行内公式改写成块级，反而改变语义。
 *
 * 两种开栏位置：
 * - 紧跟引用前缀/缩进（缩进 ≤ 3 空格，任何位置都行）；
 * - 列表标记行上直接开栏（`- $$…`、`10. $$…`）：标记 + 空格当作缩进，内容列恰好
 *   从标记后开始 —— 块内行随后补齐到这一列，才撑得住条目的续行要求。
 *
 * 缩进 ≥ 4 只在落在当前列表项内容列的窗口内（[列, 列+3]）时才认：窗口外（顶层
 * 4 空格、内容列再深 4 格）都是缩进代码块，不动。
 */
function openingFence(
  line: string,
  listContent: number | null,
): { quote: string; indent: string; rest: string } | null {
  const { quote, body } = splitQuote(line)
  const marker = LIST_MARKER.exec(body)
  let indent: string
  let rest: string
  if (marker) {
    indent = body.slice(0, marker[0].length)
    rest = body.slice(marker[0].length)
  } else {
    indent = /^ */.exec(body)?.[0] ?? ''
    rest = body.slice(indent.length)
  }
  const run = findDollarRun(rest, 0)
  if (!run || run.start !== 0) return null
  const after = rest.slice(run.length)
  if (after.includes('$')) return null

  const width = indent.length
  if (width > 3 && (quote !== '' || listContent === null || width < listContent || width > listContent + 3)) {
    return null
  }
  return { quote, indent, rest: after }
}

/** 闭合围栏在 `index` 行，并给出该行的拆分方式（行尾收尾时需要断成两行）。 */
function closingAt(
  lines: string[],
  index: number,
  quote: string,
): { kind: 'line' } | { kind: 'trailing'; at: DollarRun } | null {
  const line = lines[index]
  if (line === undefined) return null
  const split = splitQuote(line)
  // 引用前缀不一致的行不属于这个块（块在 Markdown 里本来就断在那里）
  if (split.quote !== quote) return null
  // 列表标记行上的 `$$` 是新项的开栏，不是外层块的闭合（`10. $$` 不该截断外层公式）
  if (listContentColumn(split.body) !== null) return null
  const run = findDollarRun(split.body, 0)
  if (run && split.body.slice(0, run.start).trim() === '' && split.body.slice(run.start + run.length).trim() === '') {
    return { kind: 'line' }
  }
  const trailing = trailingFence(split.body)
  return trailing ? { kind: 'trailing', at: trailing } : null
}

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * 代码围栏行（含 `>` 引用前缀写法，前缀随结果一并返回，用于开合配对）；
 * `info` 只允许出现在开栏行，闭合行必须为空。（math-commands 复用同一判定）
 */
export function codeFenceMarker(
  line: string,
): { quote: string; char: string; size: number; info: string } | null {
  const { quote, body } = splitQuote(line)
  const match = CODE_FENCE.exec(body)
  if (!match) return null
  const marker = match[1]
  return { quote, char: marker[0], size: marker.length, info: body.slice(match[0].length) }
}

/**
 * 把已闭合的块级公式围栏规范化到独占一行（含列表缩进补齐与引用前缀保持）；
 * 其余内容逐行原样输出（幂等）。
 */
export function normalizeDisplayMath(content: string): string {
  if (!content.includes('$$')) return content

  const lines = content.split('\n')
  const output: string[] = []
  let codeFence: { quote: string; char: string; size: number } | null = null
  // 最近一个列表标记行的内容列：判断 ≥ 4 空格的缩进开栏是「列表项里的公式」还是「缩进代码块」
  let listContent: number | null = null
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (codeFence) {
      const marker = codeFenceMarker(line)
      if (
        marker &&
        marker.quote === codeFence.quote &&
        marker.char === codeFence.char &&
        marker.size >= codeFence.size &&
        marker.info.trim() === ''
      ) {
        codeFence = null
      }
      output.push(line)
      index += 1
      continue
    }

    // 列表上下文：标记行更新内容列；顶格的非标记行（段落/标题/引用）结束列表。
    // 空行不清空 —— 列表跨空行仍然延续。
    const column = listContentColumn(line)
    if (column !== null) {
      listContent = column
    } else if (/^\S/.test(line)) {
      listContent = null
    }

    const marker = codeFenceMarker(line)
    if (marker) {
      codeFence = { quote: marker.quote, char: marker.char, size: marker.size }
      output.push(line)
      index += 1
      continue
    }

    const opening = openingFence(line, listContent)
    if (!opening) {
      output.push(line)
      index += 1
      continue
    }

    // 先找闭合围栏：找不到就整块原样输出 —— 流式中途的半截公式不去猜
    let closing: { kind: 'line' } | { kind: 'trailing'; at: DollarRun } | null = null
    let closeIndex = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      closing = closingAt(lines, cursor, opening.quote)
      if (closing) {
        closeIndex = cursor
        break
      }
    }

    if (closeIndex < 0 || !closing) {
      output.push(...lines.slice(index))
      break
    }

    // 引用块的改写要求块内每一行都带同一引用前缀；块中间冒出顶格列表标记说明
    // 容器在原文档里本就断开 —— 两种情况都不猜，只放走当前行继续往后扫
    const quoteMismatch =
      opening.quote !== '' &&
      lines.slice(index + 1, closeIndex).some((l) => splitQuote(l).quote !== opening.quote)
    const breaksContainer = lines
      .slice(index + 1, closeIndex)
      .some((l) => /^(?:[-*+] |\d{1,9}[.)] )/.test(l))
    if (quoteMismatch || breaksContainer) {
      output.push(line)
      index += 1
      continue
    }

    const closingLine = lines[closeIndex]
    // 块内缩进不足开栏缩进的行补齐到开栏缩进，撑住列表容器的续行要求
    //（顶层场景 padToIndent 是空操作，补掉的空格会被围栏按开栏缩进剥掉）
    const padWidth = opening.indent.length
    const withPrefix = (raw: string): string => {
      if (opening.quote === '') return padToIndent(raw, padWidth)
      const split = splitQuote(raw)
      return `${split.quote}${padToIndent(split.body, padWidth)}`
    }
    if (opening.rest.trim() === '') {
      output.push(line)
    } else {
      output.push(`${opening.quote}${opening.indent}$$`)
      // rest 是裸内容不是整行：引用前缀在这里显式带上（withPrefix 只处理整行）
      output.push(`${opening.quote}${padToIndent(opening.rest.trimStart(), padWidth)}`)
    }
    output.push(...lines.slice(index + 1, closeIndex).map(withPrefix))
    if (closing.kind === 'trailing') {
      const split = splitQuote(closingLine)
      // 拆出的两段是裸内容：引用前缀显式带上（withPrefix 只处理整行）
      output.push(`${opening.quote}${padToIndent(split.body.slice(0, closing.at.start), padWidth)}`)
      output.push(`${opening.quote}${padToIndent(split.body.slice(closing.at.start), padWidth)}`)
    } else {
      output.push(withPrefix(closingLine))
    }
    index = closeIndex + 1
  }

  return output.join('\n')
}