import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountDatabaseName, getDatabase, GUEST_DATABASE_NAME } from '@/data'
import { ACCOUNT_IDENTITY_KEY, ACCOUNT_TOKEN_KEY } from '@/services/account/client'
import { bindStoredAccountDatabase } from './data-session'
import { useReviewSessionStore } from './review-session-store'

/**
 * 冷启动绑库：库名由本机记录的账号名决定，**不联网**。
 *
 * 这是「登录用户刷新首页看到的是游客数据」那个缺陷的落点：绑定必须发生在载入 store 之前，
 * 而又不能等账号服务返回（离线会白屏、慢网会先载入游客库再被切掉）。
 */

function stubLocalStorage(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
}

beforeEach(() => {
  useReviewSessionStore.getState().reset()
})

afterEach(async () => {
  await bindStoredAccountDatabase()
  vi.unstubAllGlobals()
})

describe('冷启动绑库', () => {
  it('记住账号名时直接绑到账号库，不需要联网', async () => {
    stubLocalStorage({ [ACCOUNT_TOKEN_KEY]: 'token-1', [ACCOUNT_IDENTITY_KEY]: 'tester' })

    const needsNetwork = await bindStoredAccountDatabase()

    expect(needsNetwork).toBe(false)
    expect(getDatabase().name).toBe(accountDatabaseName('tester'))
  })

  it('没登录时回游客库', async () => {
    stubLocalStorage({})

    const needsNetwork = await bindStoredAccountDatabase()

    expect(needsNetwork).toBe(false)
    expect(getDatabase().name).toBe(GUEST_DATABASE_NAME)
  })

  it('有 token 却没记住账号名（旧版本升上来）时才需要联网确认', async () => {
    stubLocalStorage({ [ACCOUNT_TOKEN_KEY]: 'token-1' })

    const needsNetwork = await bindStoredAccountDatabase()

    expect(needsNetwork).toBe(true)
    expect(getDatabase().name).toBe(GUEST_DATABASE_NAME)
  })
})