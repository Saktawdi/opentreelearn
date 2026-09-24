import type { Id, Message, ModelRef, Node, Note, ProjectSettings } from '@/domain/models'
import { messageText } from '@/domain/messages'
import {
  assembleReviewContext,
  buildReviewMaterial,
  type ReviewContextMessage,
} from '@/domain/context/review'
import type { ReviewItemPhase, ReviewRequestPurpose, ReviewSessionItem } from '@/domain/review/session'
import { stripReviewRating } from '@/domain/review/protocol'
import { newId } from '@/lib/id'
import { describeLlmError, formatErrorMessage } from './errors'
import { findProvider } from './catalog'
import { requireModel } from './providers'
import { streamReply, toModelMessages, type ChatUsage } from './chat'
import type { GlobalSettings } from '@/domain/models'

/**
 * 复习专用模型服务。
 *
 * 与学习聊天**完全隔离**：各自的 abort controller、各自的流式状态、各自的消息落点。
 * 复习消息写进会话文档，不写进节点的普通 `messages` 流 —— 否则会污染原节点的可见路径、
 * 分支继承与 T-187 版本结构，复习完再打开节点会看到一堆「出题」「点评」。
 *
 * 一次请求的产物固定包含：请求 id（迟到回调靠它被丢弃）、用途、材料版本与
 * **实际使用的材料文本**（原版本被淘汰后仍要能看当初依据的是什么）。
 */

export interface ReviewRequestInput {
  settings: GlobalSettings
  projectSettings?: ProjectSettings | null
  projectName?: string
  projectDescription?: string
  node: Node
  nodes: Node[]
  messagesByNode: Map<Id, Message[]>
  notesByMessage?: Map<Id, Note[]>
  item: ReviewSessionItem
  purpose: ReviewRequestPurpose
  /** 本轮要发给模型的新内容（学习者回答 / 追问 / 空的触发语） */
  text: string
  signal: AbortSignal
  onDelta?: (delta: string) => void
  /** 本次是第几个主题 / 共几个，写进上下文帮模型掌握节奏 */
  progressNote?: string
  now?: number
}

export interface ReviewRequestOutput {
  requestId: Id
  text: string
  /** 剥掉判定标记后的正文（会话消息里存这个） */
  clean: string
  usage?: ChatUsage
  modelRef?: ModelRef
  aborted: boolean
  /** 本次实际使用的资料文本与版本，供会话快照保存 */
  materialText: string
  materialVersion: string
  materialTruncated: boolean
}

export interface ReviewRequestFailure {
  requestId: Id
  /** 已生成的（不完整）正文；**不采纳其中的评分标记** */
  partial: string
  message: string
  hint?: string
  aborted: boolean
}

/** 把会话项里已有的消息转成模型能读的对话（判定标记剥掉，模型不需要看到两遍）。 */
function itemHistory(item: ReviewSessionItem): ReviewContextMessage[] {
  return item.messages.map((message) => ({
    role: message.role,
    parts: [{ type: 'text', text: stripReviewRating(message.text) }],
  }))
}

/** 本轮触发语：把「用户做了什么」写成一句明确的指令，避免模型把空消息当成误发。 */
function triggerText(purpose: ReviewRequestPurpose, text: string): string {
  const trimmed = text.trim()
  if (trimmed) return trimmed
  switch (purpose) {
    case 'question':
      return '请出题。'
    case 'relearn':
      return '我还没掌握，先给我讲关键点。'
    case 'hint':
      return '给一点提示。'
    case 'rephrase':
      return '换个问法。'
    case 'answer':
      return '（学习者直接提交了完整回答，见上一条）'
    default:
      return '继续。'
  }
}

export async function requireReviewModel(
  settings: GlobalSettings,
  projectSettings?: ProjectSettings | null,
): Promise<{ model: Awaited<ReturnType<typeof requireModel>>; ref?: ModelRef }> {
  const ref = projectSettings?.chatModelRef ?? settings.defaultChatModelRef ?? undefined
  const model = await requireModel(settings, ref ?? null, '对话模型')
  return { model, ref }
}

/**
 * 跑一次复习请求。
 *
 * 失败时**不抛异常**：返回结构化的失败信息（含已生成的正文与错误提示），
 * 由调用方决定停在哪个阶段、要不要重试。复习的失败必须是可恢复的 ——
 * 一次网络抖动不该把用户刚写的回答弄丢。
 */
export async function runReviewRequest(
  input: ReviewRequestInput,
): Promise<{ ok: true; output: ReviewRequestOutput } | { ok: false; failure: ReviewRequestFailure }> {
  const requestId = newId()

  let model
  let ref: ModelRef | undefined
  try {
    const resolved = await requireReviewModel(input.settings, input.projectSettings)
    model = resolved.model
    ref = resolved.ref
  } catch (error) {
    const info = describeLlmError(error)
    return {
      ok: false,
      failure: { requestId, partial: '', message: info.message, hint: info.hint, aborted: false },
    }
  }

  const material = buildReviewMaterial({
    node: input.node,
    nodes: input.nodes,
    messagesByNode: input.messagesByNode,
    notesByMessage: input.notesByMessage,
    budgetTokens: input.settings.contextBudget,
  })

  const history = itemHistory(input.item)
  history.push({ role: 'user', parts: [{ type: 'text', text: triggerText(input.purpose, input.text) }] })

  const context = assembleReviewContext({
    node: input.node,
    purpose: input.purpose,
    material,
    history,
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    backgroundProfile: input.settings.backgroundProfile,
    projectBackground: input.projectSettings?.backgroundProfile,
    projectSystemPrompt: input.projectSettings?.systemPrompt,
    usedHint: input.item.usedHint,
    usedSource: input.item.usedSource,
    progressNote: input.progressNote,
  })

  // 已生成的部分要留着：中断的正文是内容（用户看得见），只是**不采纳其中的评分标记**
  let partial = ''

  try {
    const result = await streamReply({
      model,
      system: context.system,
      messages: toModelMessages(context.messages),
      abortSignal: input.signal,
      // 跟随提供商配置的推理强度；非法值/auto 由 chat 层过滤为不传
      reasoningEffort: findProvider(input.settings.providers, ref)?.reasoningEffort,
      onDelta: (delta) => {
        partial += delta
        input.onDelta?.(delta)
      },
    })

    return {
      ok: true,
      output: {
        requestId,
        text: result.text,
        clean: stripReviewRating(result.text),
        usage: result.usage,
        modelRef: ref,
        aborted: result.aborted,
        materialText: material.text,
        materialVersion: material.versionId,
        materialTruncated: material.truncated,
      },
    }
  } catch (error) {
    const info = describeLlmError(error)
    return {
      ok: false,
      failure: {
        requestId,
        partial,
        message: formatErrorMessage(info),
        hint: info.hint,
        aborted: false,
      },
    }
  }
}

/** 复习阶段 → 是否需要请求模型（界面据此决定按钮与骨架屏）。 */
export function phaseNeedsModel(phase: ReviewItemPhase): boolean {
  return phase === 'preparing' || phase === 'evaluating'
}

/** 会话消息的展示文本（历史记录、资料面板都用它）。 */
export function reviewMessageText(message: { text: string }): string {
  return stripReviewRating(message.text)
}

/** 把节点可见对话渲染成纯文本（资料面板与材料快照共用一处口径）。 */
export function visibleThreadText(_node: Node, messages: Message[], limit = 40): string {
  return messages
    .slice(-limit)
    .map((message) => {
      const speaker = message.role === 'assistant' ? '导师' : '学习者'
      return `${speaker}：${messageText(message)}`
    })
    .join('\n\n')
}