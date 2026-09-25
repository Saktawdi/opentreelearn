import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '发生未知错误'
}
/** 把流式失败的技术性错误串翻译成用户能读懂的一句话；认不出的原样返回。 */
export function humanizeStreamError(error: string): string {
  const text = error.toLowerCase()
  if (/abort/.test(text)) return '已停止生成'
  if (/failed to fetch|fetch failed|network|econnrefused|enotfound/.test(text))
    return '网络连接失败，请检查网络或代理后重试'
  if (/401|403|unauthorized|forbidden|api ?key|invalid_api_key/.test(text))
    return '模型服务鉴权失败，请到「配置」检查 API Key'
  if (/429|rate ?limit|quota/.test(text)) return '请求太频繁或额度不足，稍后再试'
  if (/timeout|timed out|etimedout/.test(text)) return '请求超时，稍后再试'
  if (/5\d\d|internal server error|bad gateway|service unavailable/.test(text))
    return '模型服务暂时不可用，稍后再试'
  return error
}
