import i18n from '@/i18n'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return i18n.t('common:error.unknown')
}
/** 把流式失败的技术性错误串翻译成用户能读懂的一句话；认不出的原样返回。 */
export function humanizeStreamError(error: string): string {
  const text = error.toLowerCase()
  if (/abort/.test(text)) return i18n.t('common:error.aborted')
  if (/failed to fetch|fetch failed|network|econnrefused|enotfound/.test(text))
    return i18n.t('common:error.network')
  if (/401|403|unauthorized|forbidden|api ?key|invalid_api_key/.test(text))
    return i18n.t('common:error.auth')
  if (/429|rate ?limit|quota/.test(text)) return i18n.t('common:error.rateLimit')
  if (/timeout|timed out|etimedout/.test(text)) return i18n.t('common:error.timeout')
  if (/5\d\d|internal server error|bad gateway|service unavailable/.test(text))
    return i18n.t('common:error.unavailable')
  return error
}
