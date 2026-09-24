import {
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type { ContextMessage, ContextPart } from '@/domain/context/assemble'
import { isValidReasoningLevel } from './model-catalog'
import { DEFAULT_AGENT_MAX_STEPS } from '@/domain/defaults'

export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
}

/** 一次工具调用的「举手」：模型给了参数、还没执行。 */
export interface ToolActivity {
  callId: string
  name: string
  input: unknown
}

/** 一次工具调用的结局：结果或失败。两者必居其一。 */
export interface ToolOutcome {
  callId: string
  name: string
  output?: string
  error?: string
}

export interface StreamReplyParams {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  abortSignal?: AbortSignal
  onDelta?: (delta: string) => void
  /**
   * 本轮可用的工具。
   *
   * **缺省 = 完全不带工具**：请求体与不带工具的今天逐字节一致（回归底线）。
   * 只读工具的 P-A 阶段，工具记录不落库，因此这里不需要关心消息配对。
   */
  tools?: ToolSet
  /** 最多走几步（含工具步）；只在给了工具时生效。**0 = 不限制**。缺省取全局默认。 */
  maxSteps?: number
  /**
   * 推理强度（未校验的自由文本）。
   * 只有属于 SDK 合法档位（`model-catalog.ALLOWED_REASONING_LEVELS`）的值才会
   * 注入请求的顶层 `reasoning` 字段；'auto'/非法值一律不传 —— API 层不认识的值
   * 会被适配器静默忽略，与其送出假档位不如不带。
   */
  reasoningEffort?: string
  onToolCall?: (activity: ToolActivity) => void
  onToolResult?: (outcome: ToolOutcome) => void
}

export interface StreamReplyResult {
  text: string
  usage?: ChatUsage
  finishReason?: string
  aborted: boolean
  /** 本轮实际发生的工具调用次数 */
  toolCalls: number
  /** 是否在「最后一步还在调工具」时停下（步数用尽，答案可能不完整） */
  hitStepLimit: boolean
}

export function mediaTypeOfDataUrl(dataUrl: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl)
  return match ? match[1] : undefined
}

/** 每个 part 是一个独立语块（引用片段、正文、图片占位），用空行分隔才不会互相并进 Markdown 结构里。 */
export function partsToText(parts: ContextPart[]): string {
  return parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

/**
 * 一条 app 消息展开成 provider 要求的消息序列（**承重墙**）。
 *
 * 厂商的硬性要求：`assistant(tool_call)` 之后必须紧跟对应的 `tool(tool_result)`，
 * 少了任何一半接口直接 400。我们把「举手 + 结果」内联在同一个 part 里，所以
 * 展开时只要保证「一个 tool part 一定同时产出 tool-call 与 tool-result」即可：
 *
 * ```
 * parts = [text₁, tool₁(call+result), text₂]
 *   → { role:'assistant', content:[text₁, tool-call₁] }
 *     { role:'tool',      content:[tool-result₁] }
 *     { role:'assistant', content:[text₂] }
 * ```
 *
 * 三条规则：
 * 1. **连续的工具调用共用一条工具结果消息**（一步里同时调两个工具是合法的）；
 * 2. 文本出现在工具调用之后 = 新的一步开始 → 先把上一段封口；
 * 3. 没有 `output` 也没有 `error` 的半截记录（中断产生）**整条丢弃**。
 *
 * 不变量（有单测锁住）：展开结果里每个 tool-call 都有紧随的 tool-result，反之亦然。
 */
function expandAssistantParts(parts: ContextPart[], result: ModelMessage[]): void {
  let texts: string[] = []
  let calls: Array<Extract<ContextPart, { type: 'tool' }>> = []

  const flush = () => {
    if (texts.length === 0 && calls.length === 0) return

    if (calls.length === 0) {
      // 纯文本段：保持与今天完全一致的形状（字符串 content），不带工具的请求体才逐字节相同
      result.push({ role: 'assistant', content: texts.join('\n\n') })
    } else {
      result.push({
        role: 'assistant',
        content: [
          ...texts.map((text) => ({ type: 'text' as const, text })),
          ...calls.map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.callId,
            toolName: call.name,
            input: call.input,
          })),
        ],
      })
      result.push({
        role: 'tool',
        content: calls.map((call) => ({
          type: 'tool-result' as const,
          toolCallId: call.callId,
          toolName: call.name,
          output:
            call.error !== undefined
              ? { type: 'error-text' as const, value: call.error }
              : { type: 'text' as const, value: call.output ?? '' },
        })),
      })
    }

    texts = []
    calls = []
  }

  for (const part of parts) {
    if (part.type === 'text') {
      // 工具调用之后又出正文 ⇒ 新的一步，先把上一段（含它的工具结果）封口
      if (calls.length > 0) flush()
      texts.push(part.text)
      continue
    }
    if (part.type === 'tool') {
      if (part.output === undefined && part.error === undefined) continue
      calls.push(part)
    }
  }

  flush()
}

export function toModelMessages(context: ContextMessage[]): ModelMessage[] {
  const result: ModelMessage[] = []

  for (const message of context) {
    if (message.role === 'assistant') {
      expandAssistantParts(message.parts, result)
      continue
    }

    const hasImage = message.parts.some((part) => part.type === 'image')
    if (!hasImage) {
      result.push({ role: 'user', content: partsToText(message.parts) })
      continue
    }

    result.push({
      role: 'user',
      content: message.parts
        .filter((part) => part.type === 'text' || part.type === 'image')
        .map((part) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : {
                type: 'image' as const,
                image: part.dataUrl,
                mediaType: mediaTypeOfDataUrl(part.dataUrl),
              },
        ),
    })
  }

  return result
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && error.name === 'AbortError'
}

/** 工具输出统一转成字符串：我们的工具返回字符串，但别对第三方工具的输出做假设。 */
function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === undefined || output === null) return ''
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/**
 * 组装 `streamText` 的参数（纯函数，可单测）。
 *
 * **回归底线**：不带工具时**不能出现** `tools` / `stopWhen` 任何一个键 ——
 * 这样请求体与「还没有工具调用能力」的今天逐字节一致，任何意外都会在 diff 里露出来。
 * `reasoning` 同理：只有给出合法档位时才出现该键。
 */
export function buildStreamOptions(params: {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  abortSignal?: AbortSignal
  tools?: ToolSet
  maxSteps?: number
  reasoningEffort?: string
}): Parameters<typeof streamText>[0] {
  const hasTools = params.tools !== undefined && Object.keys(params.tools).length > 0
  const maxSteps = params.maxSteps ?? DEFAULT_AGENT_MAX_STEPS
  const reasoningEffort = isValidReasoningLevel(params.reasoningEffort)
    ? params.reasoningEffort
    : undefined

  return {
    model: params.model,
    system: params.system,
    messages: params.messages,
    abortSignal: params.abortSignal,
    // maxSteps = 0 表示不限制。注意：streamText 缺省 stopWhen 是 stepCountIs(1)（一步就停），
    // 所以「不限制」必须显式传空数组（没有任何停止条件），而不是不传。
    ...(hasTools
      ? { tools: params.tools, stopWhen: maxSteps > 0 ? stepCountIs(maxSteps) : [] }
      : {}),
    ...(reasoningEffort ? { reasoning: reasoningEffort } : {}),
    // 关掉 SDK 遥测：本项目不接任何遥测，而它在浏览器里会留下一个无人处理的 promise。
    // streamText 把 `result.usage.then(() => {})` 当作遥测的「完成信号」，只有 Node 分支
    // （openTelemetryChannelSpanContext 里 isNodeRuntime() 为真）会顺手 .catch 掉它；
    // 浏览器里没有接住的人。于是**在第一个 step 结束前中断**时（点了停止、离开复习页、
    // 同一项被新请求顶掉），SDK 用 abortSignal.reason 拒绝全部结果 promise，控制台就出现
    // 「Uncaught (in promise) DOMException: The operation was aborted.」——中断是正常操作，
    // 不该报成未捕获异常。isEnabled: false 时 SDK 根本不建这个完成信号，问题消失。
    telemetry: { isEnabled: false },
  }
}

export async function streamReply(params: StreamReplyParams): Promise<StreamReplyResult> {
  const maxSteps = params.maxSteps ?? DEFAULT_AGENT_MAX_STEPS
  const hasTools = params.tools !== undefined && Object.keys(params.tools).length > 0

  const result = streamText(buildStreamOptions(params))

  let text = ''
  let aborted = false
  let toolCalls = 0

  try {
    // 必须读 fullStream 而不是 textStream：后者只吐 text-delta，
    // 工具调用与结果都不在里面（见设计文档 6.4）。
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          text += part.text
          params.onDelta?.(part.text)
          break
        case 'tool-call':
          toolCalls += 1
          params.onToolCall?.({
            callId: part.toolCallId,
            name: part.toolName,
            input: part.input,
          })
          break
        case 'tool-result':
          params.onToolResult?.({
            callId: part.toolCallId,
            name: part.toolName,
            output: stringifyToolOutput(part.output),
          })
          break
        case 'tool-error':
          params.onToolResult?.({
            callId: part.toolCallId,
            name: part.toolName,
            error: part.error instanceof Error ? part.error.message : String(part.error),
          })
          break
        case 'error':
          // 交给下面统一的 catch：厂商错误、网络错误都从这一条路径出去
          throw part.error
        default:
          break
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      aborted = true
    } else {
      throw error
    }
  }

  const usage = await result.usage.then(
    (value) => ({
      inputTokens: value.inputTokens ?? undefined,
      outputTokens: value.outputTokens ?? undefined,
    }),
    () => undefined,
  )

  const finishReason = await result.finishReason.then(
    (value) => String(value),
    () => undefined,
  )

  // 步数用尽：最后一步仍在举手 —— 答案可能不完整，界面要如实提示。
  // maxSteps = 0（不限制）时没有「用尽」一说，恒为 false。
  const steps = await result.steps.then(
    (value) => value,
    () => undefined,
  )
  const hitStepLimit =
    hasTools &&
    maxSteps > 0 &&
    steps !== undefined &&
    steps.length >= maxSteps &&
    (steps[steps.length - 1]?.toolCalls?.length ?? 0) > 0

  return { text, usage, finishReason, aborted, toolCalls, hitStepLimit }
}