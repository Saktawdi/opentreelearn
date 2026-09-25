import { normalizeWhitespace } from '@/lib/text'

/**
 * 标注条里的单行预览。
 *
 * quote 存的是**源文**（公式连同 `$…$` 一起，见 note-anchor.ts），一行里塞 `$` 只会更挤；
 * 展示时把公式定界符收掉，里面的 LaTeX 仍照原样 —— 这是预览，不是可以复制的正文。
 * 标注条与复习笔记历史共用这一套预览口径，单独成文件以便双方引用而不牵连组件热更新。
 */
export function quotePreview(quote: string): string {
  return normalizeWhitespace(quote.replace(/\$\$?/g, ''))
}
