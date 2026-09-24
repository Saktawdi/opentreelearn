import type { Id, ReviewGrade } from '@/domain/models'
import type { ReviewItemPhase, ReviewSessionItem, ReviewSessionMessage } from './session'

/**
 * 交付守卫与「当前题」不变量（纯函数）。
 *
 * Agent 化之后，题目 / 提示 / 反馈由模型通过交付工具写入转录。工具层能校验的
 * 一切状态都来自这里 —— 守卫是代码而不是提示词，模型违反会收到结构化错误并
 * 在同一轮内自纠。
 *
 * 核心不变量：**当前题 = 转录里最后一道未被回答的 question 消息**。回答
 * （purpose 'answer' 的用户消息）出现在它之后才闭合；中间夹的提示、换问法
 * 不影响开放性。守卫、渲染、评分锚定三处共用这一个推导，不允许各自实现。
 */

export type DeliveryCheck = { ok: true } | { ok: false; reason: string }

/** 同一主题内「反馈后重问」的上限：防止 agent 在每次回答后无限再问，主题永远到不了确认。 */
export const REASK_LIMIT_PER_ITEM = 2

/**
 * 当前开放题：从前往后走一遍转录，question 打开、answer 关闭。
 * followup / hint / rephrase 都不改变开放性 —— 换问法产生的是新 question 消息，
 * 它自己会成为当前题。
 */
export function currentOpenQuestion(item: ReviewSessionItem): ReviewSessionMessage | null {
  let open: ReviewSessionMessage | null = null
  for (const message of item.messages) {
    if (message.role === 'assistant' && message.purpose === 'question') open = message
    else if (message.role === 'user' && message.purpose === 'answer') open = null
  }
  return open
}

/** 转录里最后一道 question 消息（不论是否已回答）；没有时为 null。 */
export function latestQuestion(item: ReviewSessionItem): ReviewSessionMessage | null {
  for (let index = item.messages.length - 1; index >= 0; index -= 1) {
    const message = item.messages[index]
    if (message.role === 'assistant' && message.purpose === 'question') return message
  }
  return null
}

/**
 * 出题守卫。
 *
 * - 不带 `rephraseOf`：只允许在**没有**开放题时出题（阶段起点，或阶段 3 里旧题
 *   已被回答闭合后的再问）；
 * - 带 `rephraseOf`：必须正好指向当前开放题 —— 换问法取代它，而不是另起一题。
 */
export function canPoseQuestion(item: ReviewSessionItem, rephraseOf?: Id): DeliveryCheck {
  const open = currentOpenQuestion(item)
  if (rephraseOf !== undefined) {
    if (!open) return { ok: false, reason: '没有可以换问法的开放题目' }
    if (open.id !== rephraseOf) return { ok: false, reason: '只能对当前这道未回答的题换问法' }
    return { ok: true }
  }
  if (open) return { ok: false, reason: '当前已有未回答的题目，先等它被回答' }
  // 补学主题必须先有讲解、学习者确认之后才出题 —— 防止绕过确认闸门
  if (
    item.mode === 'relearn' &&
    !item.messages.some((message) => message.role === 'assistant' && message.purpose === 'relearn')
  ) {
    return { ok: false, reason: '补学主题要先讲关键点，学习者确认后再出题' }
  }
  return { ok: true }
}

/** 提示守卫：有开放题才有「针对当前题」的提示。 */
export function canGiveHint(item: ReviewSessionItem): DeliveryCheck {
  if (!currentOpenQuestion(item)) return { ok: false, reason: '没有未回答的题目，无从提示' }
  return { ok: true }
}

/**
 * 反馈守卫：最后一条用户消息必须是回答或追问 —— 两条链路都会产生判定。
 * 中间夹的提示不影响（提示是 assistant 消息）。
 */
export function canSubmitFeedback(item: ReviewSessionItem): DeliveryCheck {
  const lastUser = [...item.messages].reverse().find((message) => message.role === 'user')
  if (!lastUser || (lastUser.purpose !== 'answer' && lastUser.purpose !== 'followup')) {
    return { ok: false, reason: '学习者还没有提交回答' }
  }
  return { ok: true }
}

/**
 * 补学守卫（阶段 1）：补学主题、且还没有任何消息 —— 也就是补学轮的起点。
 * 阶段 3 放开「反馈轮内自主补讲」时在这里扩展，先留一个调用点。
 */
export function canTeachKeyPoints(item: ReviewSessionItem): DeliveryCheck {
  if (item.mode !== 'relearn') return { ok: false, reason: '只有补学主题才讲关键点' }
  if (item.messages.length > 0) return { ok: false, reason: '补学内容已经交付过' }
  return { ok: true }
}

/**
 * 反馈后重问次数：出现在某条回答**之后**的 question 消息数。
 * 每次这样的重问都应当先有点评与补讲 —— 超过上限说明 agent 在循环再问。
 */
export function reAskCount(item: ReviewSessionItem): number {
  let count = 0
  let answered = false
  for (const message of item.messages) {
    if (message.role === 'user' && message.purpose === 'answer') answered = true
    else if (message.role === 'assistant' && message.purpose === 'question' && answered) {
      count += 1
      answered = false
    }
  }
  return count
}

export type DeliveryKind = 'relearn' | 'question' | 'hint' | 'feedback'

/** 交付落库后的阶段：handler 据此原子地写消息 + 阶段。 */
export function phaseAfterDelivery(kind: DeliveryKind): ReviewItemPhase {
  switch (kind) {
    case 'relearn':
      return 'relearning'
    case 'question':
      return 'answering'
    case 'hint':
      return 'answering'
    case 'feedback':
      return 'feedback'
  }
}

/** 阶段 3 反馈轮自主再问的档位约束：只有答得吃力才值得补讲后再问。 */
export function reAskAllowedForGrade(grade: ReviewGrade): boolean {
  return grade === 'again' || grade === 'hard'
}
