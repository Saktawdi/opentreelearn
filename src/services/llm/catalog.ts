import i18n from '@/i18n'
import { DEFAULT_CONTEXT_LIMIT } from '@/domain/defaults'
import type { ModelRef, ProviderConfig, ProviderKind } from '@/domain/models'

/** 提供商类型的展示标签；品牌名保持原样，只有 openai-compatible 走本地化。
 *  是函数而非模块级常量：语言切换后要立刻拿到新译文。 */
export function providerKindLabel(kind: ProviderKind): string {
  if (kind === 'openai-compatible') return i18n.t('common:providerKind.openaiCompatible')
  return kind === 'anthropic' ? 'Anthropic' : kind === 'google' ? 'Google Gemini' : 'OpenAI'
}

export const PROVIDER_KIND_HINT: Record<ProviderKind, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  'openai-compatible': 'DeepSeek / Moonshot / 通义 / OpenRouter / 本地推理等',
}

export const PROVIDER_KIND_BASE_URL: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  'openai-compatible': '',
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelResolutionError'
  }
}

export function findProvider(
  providers: ProviderConfig[],
  ref: ModelRef | null | undefined,
): ProviderConfig | null {
  if (!ref) return null
  const provider = providers.find((item) => item.id === ref.providerId)
  if (!provider || !provider.apiKey.trim()) return null
  return provider
}

export function hasModel(
  providers: ProviderConfig[],
  ref: ModelRef | null | undefined,
): boolean {
  return findProvider(providers, ref) !== null
}

export function describeModelRef(
  providers: ProviderConfig[],
  ref: ModelRef | null | undefined,
): string | null {
  if (!ref) return null
  const provider = providers.find((item) => item.id === ref.providerId)
  return provider ? `${provider.label} · ${ref.modelId}` : ref.modelId
}

export function listAvailableModelRefs(providers: ProviderConfig[]): ModelRef[] {
  return providers.flatMap((provider) =>
    provider.models
      .map((modelId) => modelId.trim())
      .filter(Boolean)
      .map((modelId) => ({ providerId: provider.id, modelId })),
  )
}

export function describeProviderModels(provider: ProviderConfig): string {
  return provider.models.join(' · ')
}

/**
 * 读取实际选中模型的上下文上限。
 *
 * 模型级配置优先；旧数据、手填但未补充上限的模型使用稳定兜底，避免把未配置
 * 误当成「无限上下文」而把整棵历史树送进请求。
 */
export function contextLimitForModel(
  providers: ProviderConfig[],
  ref: ModelRef | null | undefined,
): number {
  if (!ref) return DEFAULT_CONTEXT_LIMIT
  const provider = providers.find((item) => item.id === ref.providerId)
  const limit = provider?.modelConfigs?.[ref.modelId]?.contextLimit
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? limit
    : DEFAULT_CONTEXT_LIMIT
}
