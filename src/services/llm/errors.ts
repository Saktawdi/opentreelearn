import type { GlobalSettings, ProviderConfig } from '@/domain/models'
import { PROVIDER_KIND_BASE_URL } from './catalog'

export interface ProxyOptions {
  enabled: boolean
  url: string
}

export function resolveProxyOptions(settings: GlobalSettings): ProxyOptions {
  return {
    enabled: Boolean(settings.proxyEnabled && settings.proxyUrl.trim()),
    url: settings.proxyUrl.trim().replace(/\/+$/, ''),
  }
}

export function effectiveProviderBaseUrl(provider: ProviderConfig): string {
  return provider.baseURL?.trim() || PROVIDER_KIND_BASE_URL[provider.kind] || ''
}

export function applyProxyToBaseUrl(baseUrl: string, proxy: ProxyOptions): string {
  if (!proxy.enabled || !proxy.url) return baseUrl
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''
  return `${proxy.url}/${trimmed}`
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
      message: '请求被浏览器跨域策略拦截或网络不可达',
      hint: '该服务未返回跨域头。请在终端运行 pnpm proxy 启动本地代理，并在「配置 → 网络与跨域」中开启。',
    }
  }

  if (/no output generated/.test(lower)) {
    return {
      kind: 'empty',
      message: '模型没有返回有效内容',
      hint: '通常是因为跨域拦截、Base URL 未以 /v1 结尾、或模型 ID 不支持流式。可先测试提供商连通性。',
    }
  }

  if (/401|403|unauthorized|invalid[_\s]api[_\s]key|authentication/.test(lower)) {
    return {
      kind: 'auth',
      message: 'API Key 无效或没有访问权限',
      hint: '请前往「配置」页检查 API Key 与模型权限。',
    }
  }

  if (/429|rate limit|too many requests|quota|insufficient_quota/.test(lower)) {
    return {
      kind: 'rate',
      message: '触发频率限制或额度已用尽',
      hint: '请稍后重试，或检查账户余额与账单设置。',
    }
  }

  if (/404|not found|does not exist|model_not_found|unknown model/.test(lower)) {
    return {
      kind: 'model',
      message: '接口路径或模型 ID 不存在',
      hint: '请确认 Base URL 是否完整（如包含 /v1），并核对模型 ID 拼写。',
    }
  }

  if (/400|bad request|invalid_request_error/.test(lower)) {
    return {
      kind: 'request',
      message: '请求被服务端拒绝',
      hint: '请检查模型 ID 是否支持当前提问格式（如图片输入）。',
    }
  }

  if (/timeout|timed out|abort/.test(lower)) {
    return {
      kind: 'timeout',
      message: '请求超时或已取消',
    }
  }

  const primary = chain[0] || '请求发生未知错误'
  return {
    kind: 'unknown',
    message: primary,
  }
}

export function formatErrorMessage(info: LlmErrorInfo): string {
  return info.hint ? `${info.message}（${info.hint}）` : info.message
}