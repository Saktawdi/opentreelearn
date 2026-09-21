/**
 * 「每天最多提示一次」的记账。
 *
 * 通知预算的另一半（队列封顶 20/天）在 `domain/review/queue`。这里只解决
 * 「别反复弹」：把最后一次提示的日期写进 localStorage，同一天再调用就不弹。
 *
 * 存储访问一律包在 try 里：隐私模式 / 存储被禁用时，功能退化成「每次都提示」
 * 也好过抛异常把页面打崩。
 */

const STORAGE_PREFIX = 'otl:daily-notice:'

function todayKey(now: number): string {
  const date = new Date(now)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function read(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // 存不了就算了：最坏情况是这次会话里多提示一次
  }
}

/** 今天是否还没提示过。`storage` 可注入，便于单测。 */
export function shouldNotifyToday(
  key: string,
  now = Date.now(),
  storage: Storage | undefined = globalThis.localStorage,
): boolean {
  return read(storage, `${STORAGE_PREFIX}${key}`) !== todayKey(now)
}

/** 记下「今天提示过了」。 */
export function markNotifiedToday(
  key: string,
  now = Date.now(),
  storage: Storage | undefined = globalThis.localStorage,
): void {
  write(storage, `${STORAGE_PREFIX}${key}`, todayKey(now))
}