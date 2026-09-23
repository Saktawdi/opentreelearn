import { generateText, stepCountIs, tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { GlobalSettings, ModelRef, ProviderConfig } from '@/domain/models'
import { ModelResolutionError, findProvider } from './catalog'
import { effectiveProviderBaseUrl } from './errors'
import { createLlmProxyFetch } from './proxy'

/** 四个适配包共用：把跨域请求改写成同源 /api-proxy（见 proxy.ts），baseURL 本身保持上游原样。 */
const proxyFetch = createLlmProxyFetch()

export async function createLanguageModel(
  provider: ProviderConfig,
  modelId: string,
): Promise<LanguageModel> {
  const baseURL = effectiveProviderBaseUrl(provider) || undefined

  switch (provider.kind) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      return createOpenAI({ apiKey: provider.apiKey, baseURL, fetch: proxyFetch })(modelId)
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      return createAnthropic({ apiKey: provider.apiKey, baseURL, fetch: proxyFetch })(modelId)
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      return createGoogleGenerativeAI({ apiKey: provider.apiKey, baseURL, fetch: proxyFetch })(
        modelId,
      )
    }
    case 'openai-compatible': {
      if (!baseURL) {
        throw new ModelResolutionError('OpenAI 兼容提供商需要填写 Base URL')
      }
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
      return createOpenAICompatible({
        name: provider.label || 'compatible',
        apiKey: provider.apiKey,
        baseURL,
        fetch: proxyFetch,
      })(modelId)
    }
  }

  throw new ModelResolutionError(`未知的提供商类型：${String(provider.kind)}`)
}

export async function resolveModel(
  settings: GlobalSettings,
  ref: ModelRef | null | undefined,
): Promise<LanguageModel | null> {
  const provider = findProvider(settings.providers, ref)
  if (!provider || !ref) return null
  return createLanguageModel(provider, ref.modelId)
}

export async function requireModel(
  settings: GlobalSettings,
  ref: ModelRef | null | undefined,
  label: string,
): Promise<LanguageModel> {
  const model = await resolveModel(settings, ref)
  if (!model) {
    throw new ModelResolutionError(`尚未配置${label}，请前往「配置」页添加提供商与模型`)
  }
  return model
}

export interface ProviderProbe {
  /** 模型的回复文本（连通性证据） */
  text: string
  /** 是否支持工具调用（function calling）；探测不出来时按不支持处理 */
  tools: boolean
}

/**
 * 连接测试：连通性 + **工具调用能力**探测。
 *
 * 为什么必须探：工具走各家原生 function calling，而自建中转可能**静默忽略 `tools`**
 * —— 模型永远不举手却不报错，用户只会以为「AI 不想用工具」。这里发一个无副作用的
 * 工具（读取当前时间），看响应里有没有 tool_call，把结论交给调用方存进 provider。
 *
 * 带工具失败时（有的网关对不认识的字段直接 400）退回纯文本测试：
 * 连通性结论仍然有效，只是能力位记成不支持。
 */
export async function testProviderConnection(
  provider: ProviderConfig,
  modelId: string,
): Promise<ProviderProbe> {
  const model = await createLanguageModel(provider, modelId)

  const probe = tool({
    description: '读取当前时间。用于确认这个模型能否调用工具。',
    inputSchema: z.object({}),
    execute: async () => new Date().toISOString(),
  })

  try {
    const { text, steps } = await generateText({
      model,
      prompt: '请调用 get_current_time 工具读取当前时间，然后用一句话回复。',
      tools: { get_current_time: probe },
      stopWhen: stepCountIs(2),
    })
    const tools = steps.some((step) => (step.toolCalls?.length ?? 0) > 0)
    return { text, tools }
  } catch {
    // 带工具这一路失败：可能是不认 tools 字段，也可能是网络/鉴权问题。
    // 纯文本再试一次 —— 它失败就把错误抛出去（那才是要告诉用户的结论）。
    const { text } = await generateText({
      model,
      prompt: '回复两个字：可用',
    })
    return { text, tools: false }
  }
}