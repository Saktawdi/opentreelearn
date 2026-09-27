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
 * 这里只做一件事：把**已闭合的**块级公式的两个围栏都挪到独占一行。三条边界：
 *
 * - 单行 `$$…$$` 与行内 `$…$` 一律原样保留 —— 它们走行内解析，本来就不触发上面两条规则；
 * - 代码围栏（``` / ~~~）内部不动，避免改坏代码示例；
 * - **没找到闭合围栏的块不做任何改写**：流式生成中途的半截公式本来就会被解析器按
 *   文末自动闭合处理，替它补围栏只会把「显示原文」变成「红色报错」，白白更差。
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

/** 整行只有 `$$`（行首可有空白、行尾只允许空白）：块级公式的合法闭合围栏。 */
function isClosingFenceLine(line: string): boolean {
  const run = findDollarRun(line, 0)
  if (!run) return false
  return line.slice(0, run.start).trim() === '' && line.slice(run.start + run.length).trim() === ''
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
 * 行首（缩进 ≤ 3）的 `$$` 开栏，且开栏行自身不闭合、开栏后不含 `$`。
 *
 * 开栏后含 `$` 的行（`$$E = mc^2$$`）解析器本来就不会按块级处理，必须原样放过，
 * 否则会把一段行内公式改写成块级，反而改变语义。
 */
function openingFence(line: string): { indent: string; rest: string } | null {
  const indent = /^ {0,3}/.exec(line)?.[0] ?? ''
  const body = line.slice(indent.length)
  const run = findDollarRun(body, 0)
  if (!run || run.start !== 0) return null
  const rest = body.slice(run.length)
  if (rest.includes('$')) return null
  return { indent, rest }
}

/** 闭合围栏在 `index` 行，并给出该行的拆分方式（行尾收尾时需要断成两行）。 */
function closingAt(
  lines: string[],
  index: number,
): { kind: 'line' } | { kind: 'trailing'; at: DollarRun } | null {
  const line = lines[index]
  if (line === undefined) return null
  if (isClosingFenceLine(line)) return { kind: 'line' }
  const trailing = trailingFence(line)
  return trailing ? { kind: 'trailing', at: trailing } : null
}

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/

/** 代码围栏行；`info` 只允许出现在开栏行，闭合行必须为空。（math-commands 复用同一判定） */
export function codeFenceMarker(line: string): { char: string; size: number; info: string } | null {
  const match = CODE_FENCE.exec(line)
  if (!match) return null
  const marker = match[1]
  return { char: marker[0], size: marker.length, info: line.slice(match[0].length) }
}

/**
 * 把已闭合的块级公式围栏规范化到独占一行；其余内容逐行原样输出（幂等）。
 */
export function normalizeDisplayMath(content: string): string {
  if (!content.includes('$$')) return content

  const lines = content.split('\n')
  const output: string[] = []
  let codeFence: { char: string; size: number } | null = null
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (codeFence) {
      const marker = codeFenceMarker(line)
      if (
        marker &&
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

    const marker = codeFenceMarker(line)
    if (marker) {
      codeFence = { char: marker.char, size: marker.size }
      output.push(line)
      index += 1
      continue
    }

    const opening = openingFence(line)
    if (!opening) {
      output.push(line)
      index += 1
      continue
    }

    // 先找闭合围栏：找不到就整块原样输出 —— 流式中途的半截公式不去猜
    let closing: { kind: 'line' } | { kind: 'trailing'; at: DollarRun } | null = null
    let closeIndex = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      closing = closingAt(lines, cursor)
      if (closing) {
        closeIndex = cursor
        break
      }
    }

    if (closeIndex < 0 || !closing) {
      output.push(...lines.slice(index))
      break
    }

    const closingLine = lines[closeIndex]
    if (opening.rest.trim() === '') {
      output.push(line)
    } else {
      output.push(`${opening.indent}$$`)
      output.push(opening.rest.trimStart())
    }
    output.push(...lines.slice(index + 1, closeIndex))
    if (closing.kind === 'trailing') {
      output.push(closingLine.slice(0, closing.at.start))
      output.push(closingLine.slice(closing.at.start))
    } else {
      output.push(closingLine)
    }
    index = closeIndex + 1
  }

  return output.join('\n')
}