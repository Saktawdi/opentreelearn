import i18n from '@/i18n'
import type { ProviderConfig } from '@/domain/models'
import { PROVIDER_KIND_BASE_URL } from './catalog'

export function effectiveProviderBaseUrl(provider: ProviderConfig): string {
  return provider.baseURL?.trim() || PROVIDER_KIND_BASE_URL[provider.kind] || ''
}

export interface LlmErrorInfo {
  kind: 'cors' | 'auth' | 'rate' | 'model' | 'request' | 'timeout' | 'empty' | 'unknown'
  message: string
  hint?: string
}

function collectErrorChain(error: unknown, depth = 0): string[] {
  if (depth > 6 || !error) return []
  const messages: string[] = []

  if (error instanceof Error) {
    if (error.message) messages.push(error.message)
    if ('cause' in error && error.cause) {
      messages.push(...collectErrorChain(error.cause, depth + 1))
    }
  } else if (typeof error === 'string') {
    messages.push(error)
  }

  return messages
}

export function describeLlmError(error: unknown): LlmErrorInfo {
  const chain = collectErrorChain(error)
  const combined = chain.join(' | ')
  const lower = combined.toLowerCase()

  if (
    /cors|access-control-allow-origin|failed to fetch|networkerror|load failed|fetch failed|network request failed/.test(
      lower,
    )
  ) {
    return {
      kind: 'cors',
      message: i18n.t('common:errors.llm.cors'),
      hint: i18n.t('common:errors.llm.corsHint'),
    }
  }

  if (/no output generated/.test(lower)) {
    return {
      kind: 'empty',
      message: i18n.t('common:errors.llm.empty'),
      hint: i18n.t('common:errors.llm.emptyHint'),
    }
  }

  if (/401|403|unauthorized|invalid[_\s]api[_\s]key|authentication/.test(lower)) {
    return {
      kind: 'auth',
      message: i18n.t('common:errors.llm.auth'),
      hint: i18n.t('common:errors.llm.authHint'),
    }
  }

  if (/429|rate limit|too many requests|quota|insufficient_quota/.test(lower)) {
    return {
      kind: 'rate',
      message: i18n.t('common:errors.llm.rate'),
      hint: i18n.t('common:errors.llm.rateHint'),
    }
  }

  if (/404|not found|does not exist|model_not_found|unknown model/.test(lower)) {
    return {
      kind: 'model',
      message: i18n.t('common:errors.llm.model'),
      hint: i18n.t('common:errors.llm.modelHint'),
    }
  }

  if (/400|bad request|invalid_request_error/.test(lower)) {
    return {
      kind: 'request',
      message: i18n.t('common:errors.llm.request'),
      hint: i18n.t('common:errors.llm.requestHint'),
    }
  }

  if (/timeout|timed out|abort/.test(lower)) {
    return {
      kind: 'timeout',
      message: i18n.t('common:errors.llm.timeout'),
    }
  }

  const primary = chain[0] || i18n.t('common:errors.llm.unknown')
  return {
    kind: 'unknown',
    message: primary,
  }
}

export function formatErrorMessage(info: LlmErrorInfo): string {
  return info.hint ? `${info.message}（${info.hint}）` : info.message
}
