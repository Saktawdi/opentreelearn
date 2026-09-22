import type { ContextMessage } from '@/domain/context/assemble'
import { assembleFreeAskContext } from '@/domain/context/free-ask'
import type { GlobalSettings, Id, ModelRef, Node, ProjectSettings } from '@/domain/models'
import { stripReviewRating } from '@/domain/review/protocol'
import { newId } from '@/lib/id'
import { streamReply, toModelMessages, type ChatUsage } from './chat'
import { describeLlmError, formatErrorMessage } from './errors'
import { requireReviewModel } from './review'

/**
 * 复习工作区「自由问答」的模型服务。
 *
 * 与复习练习同样保持隔离：自己的 abort controller、自己的流式状态、自己的消息落点。
 * 差别在于**它不落任何库** —— 问答是「随口问一句进度」的临时内容，既不进节点对话
 * （会污染可见路径与分支继承），也不进复习会话（那里记的是评分与草稿）。
 *
 * 失败不抛异常，返回结构化失败信息（含已生成的部分）：一次网络抖动不该让用户
 * 刚打完的问题消失。
 */

export interface FreeAskRequestInput {
  settings: GlobalSettings
  projectSettings?: ProjectSettings | null
  projectName?: string
  projectDescription?: string
  nodes: Node[]
  /** 已经发生的问答，按时间顺序（不含本轮提问） */
  history: ContextMessage[]
  /** 本轮提问 */
  text: string
  signal: AbortSignal
  onDelta?: (delta: string) => void
  now?: number
}

export interface FreeAskRequestOutput {
  requestId: Id
  text: string
  /** 剥掉评分标记后的正文；可见文本一律用它 */
  clean: string
  usage?: ChatUsage
  modelRef?: ModelRef
  aborted: boolean
  /** 本次上下文实际列出的主题数 / 活跃主题总数 */
  listed: number
  total: number
}

export interface FreeAskRequestFailure {
  requestId: Id
  /** 已生成的部分正文（中断的正文是内容，用户看得见） */
  partial: string
  message: string
  hint?: string
  aborted: boolean
}

export async function runFreeAskRequest(
  input: FreeAskRequestInput,
): Promise<{ ok: true; output: FreeAskRequestOutput } | { ok: false; failure: FreeAskRequestFailure }> {
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

  const question = input.text.trim()
  const history: ContextMessage[] = [
    ...input.history,
    { role: 'user', parts: [{ type: 'text', text: question }] },
  ]

  const context = assembleFreeAskContext({
    nodes: input.nodes,
    history,
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    backgroundProfile: input.settings.backgroundProfile,
    projectBackground: input.projectSettings?.backgroundProfile,
    projectSystemPrompt: input.projectSettings?.systemPrompt,
    budgetTokens: input.settings.contextBudget,
    now: input.now,
  })

  let partial = ''

  try {
    const result = await streamReply({
      model,
      system: context.system,
      messages: toModelMessages(context.messages),
      abortSignal: input.signal,
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
        listed: context.listed,
        total: context.total,
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