import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './dexie/db'
import { createDexieRepositories } from './dexie/repos'

let db: AppDatabase
let repos: ReturnType<typeof createDexieRepositories>

beforeEach(() => {
  db = new AppDatabase(`test-budget-persist-${Math.random().toString(36).slice(2)}`)
  repos = createDexieRepositories(db)
})

describe('contextBudget 持久化与 1M', () => {
  it('保存 1,000,000 可以原样持久化到 IndexedDB 并读回（不被截到 200K，更不回退到默认 24K）', async () => {
    const initial = await repos.settings.load()
    // 默认是 24,000
    expect(initial.contextBudget).toBe(24_000)

    // 用户在配置页填 1M 保存
    await repos.settings.save({ ...initial, contextBudget: 1_000_000, updatedAt: Date.now() })

    // 重新从库里读出（等同于刷新页面 / 换路由后重新 load）
    const reloaded = await repos.settings.load()
    expect(reloaded.contextBudget).toBe(1_000_000)
  })

  it('超出 1,000,000 上限的输入会被 clamp 到 1M', async () => {
    const initial = await repos.settings.load()
    await repos.settings.save({ ...initial, contextBudget: 5_000_000 })

    const reloaded = await repos.settings.load()
    expect(reloaded.contextBudget).toBe(1_000_000)
  })
})
