import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountDatabaseName, getDatabase, getRepositories, GUEST_DATABASE_NAME, openDatabase } from '@/data'
import { createReviewSession } from '@/domain/review/session'
import { bindAccountDatabase, reloadStores } from './data-session'
import { useReviewSessionStore } from './review-session-store'

/**
 * 内存里的复习会话与本地库的绑定关系。
 *
 * 会话是**本机、按账号**的数据：库里换了一份，内存里那份就成了别的账号的东西。
 * 这两条是验收项「切账号后看不到前账号的题目和草稿；旧请求返回不能写入新账号」与
 * 「普通同步刷新不能 reset 正在进行的复习会话」的落点。
 */

const LOGIN = 'review-session-tester'

async function seedSession(projectId = 'p1') {
  const session = createReviewSession({
    projectId,
    items: [{ nodeId: 'n1', title: '前账号的题目', mode: 'review' }],
    origin: 'overview',
    now: Date.now(),
  })
  await getRepositories().reviewSessions.save(session)
  return session
}

beforeEach(async () => {
  await bindAccountDatabase(null)
  const db = getDatabase()
  await db.reviewSessions.clear()
  useReviewSessionStore.getState().reset()
})

afterEach(async () => {
  useReviewSessionStore.getState().reset()
  await bindAccountDatabase(null)
})

describe('复习会话与账号', () => {
  it('切账号时丢弃内存里的旧账号会话，迟到写入不会落进新账号的库', async () => {
    const session = await seedSession()
    // 模拟复习页正显示这份会话（草稿、回答都在内存里）
    useReviewSessionStore.setState({ session, projectId: 'p1' })

    await bindAccountDatabase(LOGIN)

    expect(useReviewSessionStore.getState().session).toBeNull()
    expect(useReviewSessionStore.getState().streaming).toBeNull()

    // 迟到的草稿保存 / 模型回包：读的是 store 里的会话，而仓储已经指向新账号的库
    await useReviewSessionStore.getState().saveDraft('这条草稿属于前账号')
    const accountDb = openDatabase(accountDatabaseName(LOGIN))
    expect(await accountDb.reviewSessions.get(session.id)).toBeUndefined()
    accountDb.close()

    // 游客库里的那份仍在原处：退出登录后还能接着做
    const guestDb = openDatabase(GUEST_DATABASE_NAME)
    expect(await guestDb.reviewSessions.get(session.id)).toBeDefined()
    guestDb.close()
  })

  it('普通同步刷新（reloadStores）保留正在进行的会话与草稿', async () => {
    const session = await seedSession()
    useReviewSessionStore.setState({ session, projectId: 'p1' })

    await reloadStores()

    expect(useReviewSessionStore.getState().session?.id).toBe(session.id)
  })
})