import { isReviewGrade, type ReviewGrade } from '@/domain/models'

/**
 * 复习评分回流的**文本协议**。
 *
 * 复习模式下，导师在点评末尾单独一行输出 `[[rating:good]]`，客户端据此把
 * AI 的判定预选在浮条上，用户一键覆盖即可。为什么不做成第二个结构化调用：
 * 判定和点评本来就是同一次回答的两面，再发一次 generateObject 既慢又贵，
 * 还会出现「点评说记得、判定说忘了」的自相矛盾。
 *
 * 标记会留在消息正文里（模型下一轮能看到自己的历史判定），展示时剥掉。
 */

const RATING_MARKER = /\[\[\s*rating\s*:\s*(again|hard|good|easy)\s*\]\]/gi

export const REVIEW_RATING_MARKER_HINT =
  '在点评的最后，单独一行输出你的判定：[[rating:again|hard|good|easy]]（四选一，不要输出别的标记）'

/** 解析最后一条判定；没有标记时返回 null（用户仍可手动评分）。 */
export function parseReviewRating(text: string): ReviewGrade | null {
  let found: ReviewGrade | null = null
  for (const match of text.matchAll(RATING_MARKER)) {
    const value = match[1]?.toLowerCase()
    if (isReviewGrade(value)) found = value
  }
  return found
}

const RATING_LINE = /^[ \t]*\[\[\s*rating\s*:\s*(again|hard|good|easy)\s*\]\][ \t]*\r?\n?/gim

/** 展示用：剥掉判定标记；独占一行的标记连整行一起去掉，不留空行。 */
export function stripReviewRating(text: string): string {
  return text.replace(RATING_LINE, '').replace(RATING_MARKER, '').trim()
}

/** 写到一半的标记（`[[`、`[[rat`、`[[rating:`…）；只允许协议本身的字符，不误伤正文。 */
const PARTIAL_MARKER = /\[\[[a-z:\s]*$/i

/**
 * 流式展示用：连写到一半的标记也一起收掉。
 *
 * 不收的话，标记会先原样出现在回答末尾，等消息落库才消失 —— 看起来像卡了一下。
 * 只匹配「`[[` 后面全是协议可能出现的字符」，普通正文里的 `[[` 不会被当成标记。
 */
export function stripStreamingReviewRating(text: string): string {
  return stripReviewRating(text).replace(PARTIAL_MARKER, '').trimEnd()
}