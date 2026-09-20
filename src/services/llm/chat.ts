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

export function partsToText(parts: ContextPart[]): string {
  return parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
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