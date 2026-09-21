import { describe, expect, it } from 'vitest'
import { markNotifiedToday, shouldNotifyToday } from './daily-notice'

/** 最小 Storage 替身：够用、可控。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

describe('daily-notice', () => {
  it('notifies once per calendar day', () => {
    const storage = memoryStorage()
    const morning = new Date(2026, 5, 10, 9, 0).getTime()
    const evening = new Date(2026, 5, 10, 22, 0).getTime()
    const tomorrow = new Date(2026, 5, 11, 8, 0).getTime()

    expect(shouldNotifyToday('review', morning, storage)).toBe(true)
    markNotifiedToday('review', morning, storage)
    expect(shouldNotifyToday('review', evening, storage)).toBe(false)
    // 跨天重新可以提示
    expect(shouldNotifyToday('review', tomorrow, storage)).toBe(true)
  })

  it('keeps keys independent', () => {
    const storage = memoryStorage()
    const now = new Date(2026, 5, 10, 9, 0).getTime()

    markNotifiedToday('a', now, storage)
    expect(shouldNotifyToday('a', now, storage)).toBe(false)
    expect(shouldNotifyToday('b', now, storage)).toBe(true)
  })

  it('degrades to always-notify when storage is unavailable', () => {
    expect(shouldNotifyToday('review', Date.now(), undefined)).toBe(true)
    expect(() => markNotifiedToday('review', Date.now(), undefined)).not.toThrow()
  })
})