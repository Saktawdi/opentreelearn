import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRepositories, getSyncLocal } from '@/data'
import type { Node, Project } from '@/domain/models'
import { reloadStores } from './data-session'
import { useAccountStore } from './account-store'
import { useSyncStore } from './sync-store'

// reloadStores 是「远端内容落库后要不要重载各 store」的开关：mock 掉，重载策略
//（见「同步后的重载策略」一组用例）按调用与否断言，同步测试本身不真去重载。
vi.mock('./data-session', () => ({
  bindAccountDatabase: vi.fn(),
  bindStoredAccountDatabase: vi.fn(),
  reloadStores: vi.fn(),
}))

/**
 * 服务端替身：只实现协议语义（rev 游标、逐条 LWW、tombstone），
 * 用来验证客户端的推送/拉取/判旧/首次登录策略，而不是重复测服务端。
 */
interface StoredRecord {
  entity: string
  id: string
  rev: number
  updatedAt: number
  deletedAt: number | null
  data: unknown
}

function createFakeServer() {
  const records = new Map<string, StoredRecord>()
  let rev = 0
  const key = (entity: string, id: string) => `${entity}|${id}`
  const calls: string[] = []
  let rejectToken: string | null = null

  return {
    calls,
    records,
    /** 让下一次请求以「token 过期」失败（用于验证 401 刷新重试） */
    expireToken(token: string) {
      rejectToken = token
    },
    push(changes: (StoredRecord & { data?: unknown })[]) {
      const applied = changes.map((change) => {
        const stored = records.get(key(change.entity, change.id))
        if (stored && change.updatedAt <= stored.updatedAt) {
          return {
            entity: change.entity,
            id: change.id,
            rev: stored.rev,
            status: 'stale' as const,
            record: stored,
          }
        }
        rev += 1
        const next: StoredRecord = {
          entity: change.entity,
          id: change.id,
          rev,
          updatedAt: change.updatedAt,
          deletedAt: change.deletedAt ?? null,
          data: change.deletedAt ? {} : (change.data ?? {}),
        }
        records.set(key(change.entity, change.id), next)
        return {
          entity: change.entity,
          id: change.id,
          rev,
          status: 'applied' as const,
        }
      })
      return { cursor: rev, applied }
    },
    pull(cursor: number) {
      const changes = [...records.values()]
        .filter((record) => record.rev > cursor)
        .sort((a, b) => a.rev - b.rev)
      return { cursor: changes.length > 0 ? changes[changes.length - 1].rev : cursor, hasMore: false, changes }
    },
    status() {
      return {
        account: { loginName: 'tester' },
        records: [...records.values()].filter((record) => record.deletedAt === null).length,
        cursor: rev,
        latestUpdatedAt: [...records.values()].reduce<number | null>(
          (max, record) => (max === null || record.updatedAt > max ? record.updatedAt : max),
          null,
        ),
      }
    },
    takeRejected() {
      const token = rejectToken
      rejectToken = null
      return token
    },
  }
}

let server: ReturnType<typeof createFakeServer>

function makeProject(id: string, name = id): Project {
  return { id, name, tags: [], createdAt: 1, updatedAt: Date.now() }
}

beforeEach(async () => {
  server = createFakeServer()
  useAccountStore.setState({ status: 'authenticated', token: 'token-1', user: { loginName: 'tester' } })
  useSyncStore.getState().reset()
  vi.mocked(reloadStores).mockClear()
  await getSyncLocal().clearLocalData()
  // clearLocalData 会落「已决策」（它服务于「以云端为准」），测试里要回到「本机没决策过」
  await getSyncLocal().writeState({ cursor: 0, initialized: false })

  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const token = (init?.headers as Record<string, string> | undefined)?.token ?? ''
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      })

    if (server.takeRejected() === token) {
      return json({ code: 401, msg: 'Token 无效或已过期，请重新登录' }, 401)
    }

    server.calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`)
    if (url.includes('/sync/push')) {
      const body = JSON.parse(String(init?.body)) as { changes: StoredRecord[] }
      return json({ code: 0, msg: '操作成功', data: server.push(body.changes) })
    }
    if (url.includes('/sync/pull')) {
      const cursor = Number(new URL(url, 'http://x').searchParams.get('cursor') ?? 0)
      return json({ code: 0, msg: '操作成功', data: server.pull(cursor) })
    }
    if (url.includes('/sync/status')) {
      return json({ code: 0, msg: '操作成功', data: server.status() })
    }
    return json({ code: 404, msg: '没有这个接口' }, 404)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAccountStore.setState({ status: 'anonymous', token: null, user: null })
})

describe('推送与拉取', () => {
  it('把本地变更推到服务端，并清空台账、推进状态', async () => {
    await getRepositories().projects.create(makeProject('p1', '本机项目'))

    const result = await useSyncStore.getState().syncNow()

    expect(result).toMatchObject({ ok: true, pushed: 1 })
    expect(server.records.get('project|p1')?.data).toMatchObject({ name: '本机项目' })
    expect(await getSyncLocal().outboxCount()).toBe(0)
    expect((await getSyncLocal().readState()).lastSyncedAt).toBeGreaterThan(0)
  })

  it('拉取远端记录写进本地，并把游标记下来（第二次不再重复拉）', async () => {
    server.push([{ entity: 'project', id: 'p9', updatedAt: 500, deletedAt: null, data: makeProject('p9', '云端项目') } as never])

    await useSyncStore.getState().syncNow()
    expect((await getRepositories().projects.get('p9'))?.name).toBe('云端项目')

    const cursorAfterFirst = (await getSyncLocal().readState()).cursor
    server.calls.length = 0
    await useSyncStore.getState().syncNow()

    // 游标已推进：第二次 pull 不会再把同一条记录发下来
    expect((await getSyncLocal().readState()).cursor).toBe(cursorAfterFirst)
    expect(server.calls.filter((call) => call.startsWith('GET') && call.includes('/sync/pull'))).toHaveLength(1)
  })

  it('服务端版本更新时判旧：用服务端版本覆盖本地，而不是硬推', async () => {
    await getRepositories().projects.create(makeProject('p1', '本机旧版本'))
    server.push([
      { entity: 'project', id: 'p1', updatedAt: Date.now() + 10_000, deletedAt: null, data: makeProject('p1', '云端新版本') } as never,
    ])

    const result = await useSyncStore.getState().syncNow()

    expect(result.ok).toBe(true)
    expect((await getRepositories().projects.get('p1'))?.name).toBe('云端新版本')
    expect(await getSyncLocal().outboxCount()).toBe(0)
  })

  it('本地删除推成 tombstone，远端 tombstone 也会删掉本地记录', async () => {
    await getRepositories().projects.create(makeProject('p1'))
    await useSyncStore.getState().syncNow()

    await getRepositories().projects.remove('p1')
    await useSyncStore.getState().syncNow()
    expect(server.records.get('project|p1')?.deletedAt).toBeTypeOf('number')

    server.push([
      { entity: 'project', id: 'p1', updatedAt: Date.now() + 5000, deletedAt: Date.now() + 5000, data: {} } as never,
    ])
    await useSyncStore.getState().syncNow()
    expect(await getRepositories().projects.get('p1')).toBeUndefined()
  })
})

describe('会话与首次登录', () => {
  it('遇到 401 先刷新会话再重试一次', async () => {
    const refresh = vi.fn(async () => {
      useAccountStore.setState({ token: 'token-2' })
      return 'token-2'
    })
    useAccountStore.setState({ refreshSession: refresh })
    server.expireToken('token-1')
    await getRepositories().projects.create(makeProject('p1'))

    const result = await useSyncStore.getState().syncNow()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(server.records.get('project|p1')).toBeDefined()
  })

  it('未决策过时只弹策略，不动数据', async () => {
    await getRepositories().projects.create(makeProject('p1'))

    await useSyncStore.getState().initialize()

    expect(useSyncStore.getState().needsPolicy).toBe(true)
    expect(server.calls.some((call) => call.includes('/sync/push'))).toBe(false)
    expect(server.records.size).toBe(0)
  })

  it('「上传本机数据（合并）」把本机记录推上去', async () => {
    await getRepositories().projects.create(makeProject('p1', '本机项目'))

    const result = await useSyncStore.getState().applyFirstLoginPolicy('merge')

    expect(result.ok).toBe(true)
    expect(server.records.get('project|p1')).toBeDefined()
    expect(useSyncStore.getState().needsPolicy).toBe(false)
    expect((await getSyncLocal().readState()).initialized).toBe(true)
  })

  it('「以云端为准」清掉本机数据再整库拉取', async () => {
    await getRepositories().projects.create(makeProject('p1', '本机项目'))
    server.push([{ entity: 'project', id: 'cloud-1', updatedAt: 10, deletedAt: null, data: makeProject('cloud-1', '云端项目') } as never])

    await useSyncStore.getState().applyFirstLoginPolicy('cloud')

    expect(await getRepositories().projects.get('p1')).toBeUndefined()
    expect((await getRepositories().projects.get('cloud-1'))?.name).toBe('云端项目')
    expect(server.records.has('project|p1')).toBe(false)
  })

  it('「暂不同步」只落决策，不推送也不拉取', async () => {
    await getRepositories().projects.create(makeProject('p1'))

    const result = await useSyncStore.getState().applyFirstLoginPolicy('localOnly')

    expect(result).toMatchObject({ ok: true, pushed: 0, pulled: 0 })
    expect(server.records.size).toBe(0)
    expect(useSyncStore.getState().needsPolicy).toBe(false)
    // 本机变更还在台账里，之后手动同步照样能推上去
    expect(await getSyncLocal().outboxCount()).toBe(1)
  })
})

describe('自动同步', () => {
  /** 让节流窗口失效：模拟「距离上次尝试已经过去很久」。 */
  async function passThrottleWindow() {
    await getSyncLocal().writeState({ lastSyncedAt: 0 })
    useSyncStore.setState({ lastAttemptAt: 0 })
  }

  it('登录且已决策过时，聚焦就同步——不必进「我的」页', async () => {
    await getSyncLocal().writeState({ initialized: true })
    await getRepositories().projects.create(makeProject('p1', '本机项目'))

    const result = await useSyncStore.getState().autoSync('focus')

    expect(result).toMatchObject({ ok: true, pushed: 1 })
    expect(server.records.get('project|p1')).toBeDefined()
  })

  it('没有待推变更时，巡检不发请求（只读本机台账）', async () => {
    await getSyncLocal().writeState({ initialized: true })
    server.calls.length = 0

    const result = await useSyncStore.getState().autoSync('pending')

    expect(result).toBeNull()
    expect(server.calls).toHaveLength(0)
  })

  it('有待推变更时巡检会推上去', async () => {
    await getSyncLocal().writeState({ initialized: true })
    await getRepositories().projects.create(makeProject('p1'))

    const result = await useSyncStore.getState().autoSync('pending')

    expect(result).toMatchObject({ ok: true, pushed: 1 })
  })

  it('节流：窗口内连续触发只同步一次，窗口过了才再同步', async () => {
    await getSyncLocal().writeState({ initialized: true })
    await getRepositories().projects.create(makeProject('p1'))

    expect(await useSyncStore.getState().autoSync('focus')).toMatchObject({ ok: true })
    // 紧接着的聚焦 / 巡检都被节流挡掉（失败也进窗口，避免连续重试）
    expect(await useSyncStore.getState().autoSync('focus')).toBeNull()
    expect(await useSyncStore.getState().autoSync('pending')).toBeNull()

    await passThrottleWindow()
    expect(await useSyncStore.getState().autoSync('focus')).toMatchObject({ ok: true })
  })

  it('没决策过首次登录策略时不替用户同步，切换账号后也不动', async () => {
    server.calls.length = 0
    expect(await useSyncStore.getState().autoSync('focus')).toBeNull()
    expect(server.calls).toHaveLength(0)

    await getSyncLocal().writeState({ initialized: true })
    useAccountStore.setState({ token: null })
    expect(await useSyncStore.getState().autoSync('focus')).toBeNull()
    expect(server.calls).toHaveLength(0)
  })
})

describe('同步后的重载策略', () => {
  it('纯推送静默完成：推上去的记录被 pull 带回时是回声，不触发重载', async () => {
    await getRepositories().projects.create(makeProject('p1', '本机项目'))

    const result = await useSyncStore.getState().syncNow()

    expect(result).toMatchObject({ ok: true, pushed: 1, pulled: 0 })
    expect(vi.mocked(reloadStores)).not.toHaveBeenCalled()
  })

  it('拉到远端增量才重载一次', async () => {
    server.push([
      { entity: 'project', id: 'p9', updatedAt: 500, deletedAt: null, data: makeProject('p9', '云端项目') } as never,
    ])

    await useSyncStore.getState().syncNow()

    expect(vi.mocked(reloadStores)).toHaveBeenCalledTimes(1)
  })

  it('远端节点只改位置（载荷时间戳未前进）也算落库，要重载', async () => {
    const node: Node = {
      id: 'n1',
      projectId: 'p1',
      parentId: null,
      forkFrom: null,
      title: 'n1',
      position: null,
      status: 'active',
      createdAt: 1,
      updatedAt: 100,
    }
    await getRepositories().nodes.create(node)
    // 本机这份已经推完（无待推变更），否则远端旧版本会被「未推送更新」闸门挡掉
    await getSyncLocal().clearOutbox(
      (await getSyncLocal().readOutbox()).map((entry) => entry.seq as number),
    )

    server.push([
      {
        entity: 'node',
        id: 'n1',
        updatedAt: Date.now(),
        deletedAt: null,
        data: { ...node, position: { x: 12, y: 34 } },
      } as never,
    ])

    await useSyncStore.getState().syncNow()

    expect((await getRepositories().nodes.get('n1'))?.position).toEqual({ x: 12, y: 34 })
    expect(vi.mocked(reloadStores)).toHaveBeenCalledTimes(1)
  })

  it('推送被判旧（服务端版本覆盖本机）也视为远端落库，要重载', async () => {
    await getRepositories().projects.create(makeProject('p1', '本机旧版本'))
    server.push([
      { entity: 'project', id: 'p1', updatedAt: Date.now() + 10_000, deletedAt: null, data: makeProject('p1', '云端新版本') } as never,
    ])

    await useSyncStore.getState().syncNow()

    expect(vi.mocked(reloadStores)).toHaveBeenCalledTimes(1)
  })
})