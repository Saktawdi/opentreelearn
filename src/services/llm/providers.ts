import { generateText, type LanguageModel } from 'ai'
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

export async function testProviderConnection(
  provider: ProviderConfig,
  modelId: string,
): Promise<string> {
  const model = await createLanguageModel(provider, modelId)
  const { text } = await generateText({
    model,
    prompt: '回复两个字：可用',
  })
  return text
}