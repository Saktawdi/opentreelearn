import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountDatabaseName, getDatabase, getRepositories, GUEST_DATABASE_NAME, openDatabase } from '@/data'
import { createReviewSession } from '@/domain/review/session'
import { bindAccountDatabase, reloadStores } from './data-session'
import { useReviewSessionStore } from './review-session-store'
import { runReviewRequest } from '@/services/llm/review'
import { makeNode } from '@/test/fixtures'
import { diagramMarkdown } from '@/lib/mermaid'

vi.mock('@/services/llm/review', () => ({ runReviewRequest: vi.fn() }))

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
  vi.mocked(runReviewRequest).mockReset()
})

describe('复习卡片中的图表', () => {
  it.each(['before', 'after', 'concurrent'] as const)('绘图发生在卡片交付 %s 时，源码落库且重新打开仍在', async (order) => {
    const session = await seedSession()
    await getDatabase().nodes.put(makeNode({ id: 'n1', projectId: 'p1' }))
    useReviewSessionStore.setState({ session, projectId: 'p1' })
    const markdown = diagramMarkdown('AOE', 'flowchart LR\n A((1)) -->|a1: 3| B((2))')
    vi.mocked(runReviewRequest).mockImplementationOnce(async (input) => {
      if (order === 'before') await input.onDiagram!(markdown)
      const delivered = input.handlers!.deliverQuestion({ question: '求图的关键路径。' })
      if (order === 'concurrent') await input.onDiagram!(markdown)
      expect(await delivered).toEqual({ ok: true })
      if (order === 'after') await input.onDiagram!(markdown)
      return { ok: true, output: {
        requestId: 'test', text: '', clean: '', aborted: false, usedDelivery: true,
        materialText: '', materialVersion: 'test', materialTruncated: false,
      } }
    })

    await useReviewSessionStore.getState().ensureCurrentItemContent()
    const saved = await getRepositories().reviewSessions.get(session.id)
    expect(saved?.items[0].messages[0].text).toBe('求图的关键路径。' + markdown)
    useReviewSessionStore.getState().reset()
    await useReviewSessionStore.getState().loadForProject('p1', session.id)
    expect(useReviewSessionStore.getState().session?.items[0].messages[0].text).toContain(markdown)
  })
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

  it('允许对 store 中的 session 与 items 进行就地变更（patchItem / settlePendingItems），不会因 Immer 冻结抛出 read-only 错误', async () => {
    const session = await seedSession()
    useReviewSessionStore.setState({ session, projectId: 'p1' })

    const cur = useReviewSessionStore.getState().session!
    expect(Object.isFrozen(cur)).toBe(false)
    expect(Object.isFrozen(cur.items[0])).toBe(false)

    // 验证保存草稿（内部调用 patchItem）能正常修改 draft 属性且不报错
    await expect(useReviewSessionStore.getState().saveDraft('测试草稿')).resolves.not.toThrow()
    expect(useReviewSessionStore.getState().session?.items[0].draft).toBe('测试草稿')

    // 验证结束本次（内部调用 settlePendingItems）能正常处理且不报错
    await expect(useReviewSessionStore.getState().endSession()).resolves.not.toThrow()
    expect(useReviewSessionStore.getState().session?.status).toBe('ended')
  })
})
