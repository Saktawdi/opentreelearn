import type { ModelRef, ProviderConfig, ProviderKind } from '@/domain/models'

export const PROVIDER_KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  'openai-compatible': 'OpenAI 兼容',
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