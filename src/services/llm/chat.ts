import { streamText, type LanguageModel, type ModelMessage } from 'ai'
import type { ContextMessage, ContextPart } from '@/domain/context/assemble'

export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface StreamReplyParams {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  abortSignal?: AbortSignal
  onDelta?: (delta: string) => void
}

export interface StreamReplyResult {
  text: string
  usage?: ChatUsage
  finishReason?: string
  aborted: boolean
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

export function toModelMessages(context: ContextMessage[]): ModelMessage[] {
  return context.map((message): ModelMessage => {
    if (message.role === 'assistant') {
      return { role: 'assistant', content: partsToText(message.parts) }
    }

    const hasImage = message.parts.some((part) => part.type === 'image')
    if (!hasImage) {
      return { role: 'user', content: partsToText(message.parts) }
    }

    return {
      role: 'user',
      content: message.parts.map((part) =>
        part.type === 'text'
          ? { type: 'text' as const, text: part.text }
          : {
              type: 'image' as const,
              image: part.dataUrl,
              mediaType: mediaTypeOfDataUrl(part.dataUrl),
            },
      ),
    }
  })
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && error.name === 'AbortError'
}

export async function streamReply(params: StreamReplyParams): Promise<StreamReplyResult> {
  const result = streamText({
    model: params.model,
    system: params.system,
    messages: params.messages,
    abortSignal: params.abortSignal,
    // 关掉 SDK 遥测：本项目不接任何遥测，而它在浏览器里会留下一个无人处理的 promise。
    // streamText 把 `result.usage.then(() => {})` 当作遥测的「完成信号」，只有 Node 分支
    // （openTelemetryChannelSpanContext 里 isNodeRuntime() 为真）会顺手 .catch 掉它；
    // 浏览器里没有接住的人。于是**在第一个 step 结束前中断**时（点了停止、离开复习页、
    // 同一项被新请求顶掉），SDK 用 abortSignal.reason 拒绝全部结果 promise，控制台就出现
    // 「Uncaught (in promise) DOMException: The operation was aborted.」——中断是正常操作，
    // 不该报成未捕获异常。isEnabled: false 时 SDK 根本不建这个完成信号，问题消失。
    telemetry: { isEnabled: false },
  })

  let text = ''
  let aborted = false

  try {
    for await (const delta of result.textStream) {
      text += delta
      params.onDelta?.(delta)
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

  return { text, usage, finishReason, aborted }
}