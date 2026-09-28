/**
 * 渲染前规范化的**唯一入口**。
 *
 * 标注坐标系建立在「喂给 Markdown 的那串文字」上（见 source-map.ts 与
 * domain/messages.messageSource）：`data-otl-src` 由渲染端在这串文字上算出，框选、
 * 高亮与写工具又拿登记进来的同一串去换算 —— 两边差一个字符，公式之后的每个标注
 * 切片都会错位，而且**全程静默**（错切是从同一串自洽推导的，自愈校验发现不了）。
 *
 * 所以「先做哪些规范化、按什么顺序」只写在这里一处：MarkdownView 渲染前调用它，
 * 所有需要与渲染对齐坐标系的消费方（messageSource、复习可标注正文）也调用它。
 * 曾经漏过一次：渲染端加了 normalizeMathCommands，登记源文没跟上，含不受支持命令
 * 的消息里，公式之后框选出的 quote 会切出 `plies$` 这类垃圾片段。
 *
 * 两个规范化都只依赖原文、各自幂等；命令替换不碰 `$` 与行结构，围栏规范化对
 * 已规范的围栏也不再改动 —— 组合因此幂等，允许登记与渲染各算一次。
 */
import { normalizeDisplayMath } from './math-fences'
import { normalizeMathCommands } from './math-commands'

export function normalizeForRender(content: string): string {
  return normalizeMathCommands(normalizeDisplayMath(content))
}
