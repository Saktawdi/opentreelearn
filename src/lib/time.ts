import i18n from '@/i18n'
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diff < minute) return i18n.t('common:time.justNow')
  if (diff < hour) return i18n.t('common:time.minutesAgo', { count: Math.floor(diff / minute) })
  if (diff < day) return i18n.t('common:time.hoursAgo', { count: Math.floor(diff / hour) })
  if (diff < 30 * day) return i18n.t('common:time.daysAgo', { count: Math.floor(diff / day) })

  return new Date(timestamp).toLocaleDateString(i18n.language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  })
}