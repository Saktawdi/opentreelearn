import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Message, Node, Project } from '@/domain/models'
import { createDefaultSettings } from '@/domain/defaults'
import { createReviewSession, type ReviewSessionRecord } from '@/domain/review/session'
import type { WireChange } from '@/domain/sync'
import { resolveThread } from '@/domain/thread/resolve'
import { AppDatabase } from './dexie/db'
import { createDexieRepositories } from './dexie/repos'
import { createSyncLocal, importRecordsInto, type SyncLocal } from './sync-local'

let db: AppDatabase
let sync: SyncLocal
let repositories: ReturnType<typeof createDexieRepositories>

function makeProject(id: string, updatedAt = 1): Project {
  return { id, name: `项目 ${id}`, tags: [], createdAt: 1, updatedAt }
}

function makeNode(id: string, projectId: string): Node {
  return {
    id,
    projectId,
    parentId: null,
    forkFrom: null,
    title: id,
    position: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  }
}

function remote(change: Partial<WireChange> & Pick<WireChange, 'entity' | 'id'>): WireChange {
  return {
    rev: 1,
    updatedAt: 100,
    deletedAt: null,
    data: {},
    ...change,
  }
}

/** 一份未完成（open）会话：`at` 同时决定它的最后活动时间。 */
function makeSession(projectId: string, nodeId: string, at: number): ReviewSessionRecord {
  return createReviewSession({
    projectId,
    items: [{ nodeId, title: `主题 ${nodeId}`, mode: 'review' }],
    origin: 'overview',
    now: at,
  })
}

/** 某项目当前未完成的会话（走仓储的索引查询，与实际读路径一致）。 */
async function openSessions(target: AppDatabase, projectId: string) {
  return target.reviewSessions.where('[projectId+open]').equals([projectId, 1]).toArray()
}

beforeEach(async () => {
  db = new AppDatabase(`test-sync-${Math.random().toString(36).slice(2)}`)
  sync = createSyncLocal(db)
  repositories = createDexieRepositories(db)
})

describe('outbox 记账', () => {
  it('create / update / remove 各记一条，删除是终点', async () => {
    await repositories.projects.create(makeProject('p1'))
    expect((await sync.readOutbox()).map((entry) => entry.op)).toEqual(['upsert'])

    await repositories.projects.update('p1', { name: '改名' })
    // 同一条记录反复改只留一条（时间取最新），不会堆积
    const afterUpdate = await sync.readOutbox()
    expect(afterUpdate).toHaveLength(1)
    expect(afterUpdate[0].entity).toBe('project')

    await repositories.projects.remove('p1')
    const afterRemove = await sync.readOutbox()
    expect(afterRemove).toHaveLength(1)
    expect(afterRemove[0].op).toBe('delete')
  })

  it('先删后建（同 id）按顺序保留两条，push 时也按这个顺序提交', async () => {
    await repositories.projects.remove('p1')
    await repositories.projects.create(makeProject('p2'))
    // create 走的是另一个 id，这里直接对同一 id 记一次 upsert
    await sync.recordChange('project', 'p1', 'upsert')

    const ops = (await sync.readOutbox()).filter((entry) => entry.localId === 'p1').map((e) => e.op)
    expect(ops).toEqual(['delete', 'upsert'])
  })

  it('本地变更的时间取「现在」与「本机版本 + 1」的较大者，避免被时钟快的设备锁住', async () => {
    // 模拟：这条记录被别的设备（时钟快）顶到未来
    const future = Date.now() + 60_000
    await repositories.projects.create(makeProject('p1', future))
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    await sync.recordChange('project', 'p1', 'upsert')
    const [entry] = await sync.readOutbox()
    expect(entry.updatedAt).toBeGreaterThan(future)
  })

  it('级联删除会为每条被删记录记账', async () => {
    await repositories.nodes.createMany([makeNode('n1', 'p1'), makeNode('n2', 'p1')])
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    await repositories.nodes.removeByProject('p1')
    const entries = await sync.readOutbox()
    expect(entries.map((entry) => `${entry.localId}:${entry.op}`).sort()).toEqual([
      'n1:delete',
      'n2:delete',
    ])
  })

  it('图片资产不进同步台账（P2 才走对象存储）', async () => {
    await repositories.assets.create({
      id: 'a1',
      projectId: 'p1',
      kind: 'image',
      mime: 'image/png',
      createdAt: 1,
      blob: new Blob(['x']),
    })
    expect(await sync.readOutbox()).toHaveLength(0)
  })
})

describe('applyRemote', () => {
  it('写入远端记录，不记账（否则会把远端变更推回去形成回环）', async () => {
    const outcome = await sync.applyRemote(
      remote({ entity: 'project', id: 'p1', data: makeProject('p1', 500) }),
    )

    expect(outcome).toBe('written')
    expect((await db.projects.get('p1'))?.name).toBe('项目 p1')
    expect(await sync.readOutbox()).toHaveLength(0)
  })

  it('tombstone 删除本地记录，项目还会级联清掉子记录', async () => {
    await repositories.projects.create(makeProject('p1'))
    await repositories.nodes.create(makeNode('n1', 'p1'))
    // 本机变更都推完了（台账清空）才是「墓碑说了算」的状态
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    const outcome = await sync.applyRemote(
      remote({ entity: 'project', id: 'p1', updatedAt: 200, deletedAt: 200, data: {} }),
    )

    expect(outcome).toBe('deleted')
    expect(await db.projects.get('p1')).toBeUndefined()
    expect(await db.nodes.get('n1')).toBeUndefined()
  })

  it('空载荷与暂不支持的实体都跳过，绝不覆盖本地好数据', async () => {
    await repositories.projects.create(makeProject('p1'))

    expect(await sync.applyRemote(remote({ entity: 'project', id: 'p1', data: {} }))).toBe('skipped')
    expect(await sync.applyRemote(remote({ entity: 'asset', id: 'a1', data: { mime: 'image/png' } }))).toBe(
      'skipped',
    )
    expect((await db.projects.get('p1'))?.name).toBe('项目 p1')
  })

  it('内容一致才算自身回声：推送后 pull 带回的同一条记录跳过，不重写本机', async () => {
    await repositories.projects.create(makeProject('p1', 100))
    const local = (await db.projects.get('p1'))!
    // 台账清空：跳过只可能来自内容比对（本机无待推更新，时间戳也不参与判定）
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    // 回声 = 服务端原样带回本机刚推上去的载荷（内容逐字段一致）；报文时间戳刻意
    // 比记录本体「新」（记账戳），也照样识别得出来
    expect(
      await sync.applyRemote(remote({ entity: 'project', id: 'p1', updatedAt: 101, data: local })),
    ).toBe('skipped')
    expect((await db.projects.get('p1'))?.name).toBe('项目 p1')
  })

  it('同一记录只要内容不同就落地，不看载荷时间戳是否前进', async () => {
    await repositories.projects.create(makeProject('p1', 100))
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    // 位置 / thread 结构 / lastStudiedAt 这些写入刻意不 bump 记录自身的 updatedAt：
    // 远端改了它们（载荷 updatedAt 仍是 100），必须照样写进来
    const outcome = await sync.applyRemote(
      remote({
        entity: 'project',
        id: 'p1',
        updatedAt: 500,
        data: { ...makeProject('p1', 100), name: '远端改的名字' },
      }),
    )

    expect(outcome).toBe('written')
    expect((await db.projects.get('p1'))?.name).toBe('远端改的名字')
  })

  it('远端只改 thread 结构（载荷 updatedAt 未前进）也落地：对端新消息照常出现在显示路径里', async () => {
    const node: Node = {
      ...makeNode('n1', 'p1'),
      updatedAt: 100,
      thread: { entries: ['m1'], slots: {} },
    }
    const messages: Message[] = [
      { id: 'm1', nodeId: 'n1', projectId: 'p1', role: 'user', parts: [{ type: 'text', text: '你好' }], createdAt: 1, updatedAt: 1 },
      { id: 'm2', nodeId: 'n1', projectId: 'p1', role: 'assistant', parts: [{ type: 'text', text: '回答' }], createdAt: 2, updatedAt: 2 },
    ]
    await repositories.nodes.create(node)
    await repositories.messages.createMany(messages)
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    // 对端把 m2 追加进 entries：thread 变了，但记录自身的 updatedAt 仍是 100
    const outcome = await sync.applyRemote(
      remote({
        entity: 'node',
        id: 'n1',
        updatedAt: 500,
        data: { ...node, thread: { entries: ['m1', 'm2'], slots: {} } },
      }),
    )

    expect(outcome).toBe('written')
    const stored = (await db.nodes.get('n1'))!
    expect(resolveThread(stored, messages).path.map((message) => message.id)).toEqual(['m1', 'm2'])
  })

  it('本机压着未推送的更新时不覆盖：那份更新带着更大的时间戳，上行后会赢', async () => {
    await repositories.projects.create(makeProject('p1', 100))
    const pendingStamp = (await sync.readOutbox())[0].updatedAt as number

    const outcome = await sync.applyRemote(
      remote({
        entity: 'project',
        id: 'p1',
        updatedAt: pendingStamp - 1,
        data: { ...makeProject('p1', 50), name: '远端旧版本' },
      }),
    )

    expect(outcome).toBe('skipped')
    expect((await db.projects.get('p1'))?.name).toBe('项目 p1')
  })

  it('远端更新比本机待推变更新时照常落地（谁赢交给服务端 LWW 裁决）', async () => {
    await repositories.projects.create(makeProject('p1', 100))
    const pendingStamp = (await sync.readOutbox())[0].updatedAt as number

    const outcome = await sync.applyRemote(
      remote({
        entity: 'project',
        id: 'p1',
        updatedAt: pendingStamp + 1,
        data: { ...makeProject('p1', pendingStamp + 1), name: '别的设备的版本' },
      }),
    )

    expect(outcome).toBe('written')
    expect((await db.projects.get('p1'))?.name).toBe('别的设备的版本')
  })

  it('本机已无此行时墓碑无事发生；本机压着更大时间戳的待推更新时也不删', async () => {
    // 从未同步过 / 已删过：无事发生
    expect(
      await sync.applyRemote(remote({ entity: 'project', id: 'p404', updatedAt: 100, deletedAt: 100 })),
    ).toBe('skipped')

    await repositories.projects.create(makeProject('p1', 100))
    const pendingStamp = (await sync.readOutbox())[0].updatedAt as number

    // 待推更新带着更大的时间戳：上行后会把它「复活」，此刻不删，交给服务端裁决
    expect(
      await sync.applyRemote(
        remote({ entity: 'project', id: 'p1', updatedAt: pendingStamp - 1, deletedAt: pendingStamp - 1 }),
      ),
    ).toBe('skipped')
    expect(await db.projects.get('p1')).toBeDefined()
  })

  it('全局设置按 provider id 保留本机 API Key（密钥从来不上云）', async () => {
    await repositories.settings.save({
      ...createDefaultSettings(),
      updatedAt: 100,
      providers: [
        { id: 'prov-1', label: '本机配置', kind: 'openai', apiKey: 'sk-local-secret', models: ['gpt-4o'] },
      ],
    })
    // 本机设置已经推完（无待推变更），云端这一版才该落地
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    await sync.applyRemote(
      remote({
        entity: 'globalSettings',
        id: 'global',
        updatedAt: 900,
        data: {
          backgroundProfile: '云端背景',
          defaultChatModelRef: null,
          titleModelRef: null,
          summaryModelRef: null,
          contextBudget: 30_000,
          providers: [{ id: 'prov-1', label: '云端名字', kind: 'openai', apiKey: '', models: ['gpt-4o'] }],
          updatedAt: 900,
        },
      }),
    )

    const stored = await repositories.settings.load()
    expect(stored.backgroundProfile).toBe('云端背景')
    expect(stored.providers[0].label).toBe('云端名字')
    expect(stored.providers[0].apiKey).toBe('sk-local-secret')
  })

  it('上传的全局设置里 API Key 被抹掉', async () => {
    await repositories.settings.save({
      ...createDefaultSettings(),
      providers: [
        { id: 'prov-1', label: 'x', kind: 'openai', apiKey: 'sk-1', models: ['m'] },
      ],
    })

    const payload = await sync.loadPayload('globalSettings', 'global')
    expect((payload?.data.providers as { apiKey: string }[])[0].apiKey).toBe('')
  })
})

describe('游标与首次登录策略', () => {
  it('状态默认未决策、游标为 0，写入后读回', async () => {
    expect(await sync.readState()).toMatchObject({ cursor: 0, initialized: false })

    await sync.writeState({ cursor: 12 })
    await sync.writeState({ initialized: true })
    expect(await sync.readState()).toMatchObject({ cursor: 12, initialized: true })
  })

  it('recordAllLocal 按记录自身的时间戳记账（云端更新的记录仍会赢）', async () => {
    await repositories.projects.create(makeProject('p1', 111))
    await repositories.nodes.create(makeNode('n1', 'p1'))
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    const count = await sync.recordAllLocal()

    expect(count).toBeGreaterThanOrEqual(2)
    const entries = await sync.readOutbox()
    expect(entries.find((entry) => entry.localId === 'p1')?.updatedAt).toBe(111)
  })

  it('clearLocalData 清空实体与台账，但保留本机 API Key', async () => {
    await repositories.projects.create(makeProject('p1'))
    await repositories.settings.save({
      ...createDefaultSettings(),
      providers: [{ id: 'prov-1', label: 'x', kind: 'openai', apiKey: 'sk-keep', models: ['m'] }],
    })

    await sync.clearLocalData()

    expect(await db.projects.count()).toBe(0)
    expect(await sync.readOutbox()).toHaveLength(0)
    expect(await sync.readState()).toMatchObject({ cursor: 0, initialized: true })
    // 密钥只在本机有，清掉就再也回不来 —— 设置行必须留着
    const stored = await repositories.settings.load()
    expect(stored.providers[0].apiKey).toBe('sk-keep')
  })
})

describe('首次登录搬运游客数据', () => {
  it('把游客库的记录搬进账号库，设置只在目标库还没有时导入', async () => {
    const guest = new AppDatabase(`test-guest-${Math.random().toString(36).slice(2)}`)
    const guestRepos = createDexieRepositories(guest)
    await guestRepos.projects.create(makeProject('guest-p1', 111))
    await guestRepos.nodes.create(makeNode('guest-n1', 'guest-p1'))
    await guestRepos.settings.save({
      ...createDefaultSettings(),
      updatedAt: 111,
      backgroundProfile: '游客背景',
    })

    // 目标库（账号库）里已经有别的项目与云端设置 → 设置不该被游客版覆盖
    await repositories.projects.create(makeProject('cloud-p1', 999))
    await repositories.settings.save({
      ...createDefaultSettings(),
      updatedAt: 999,
      backgroundProfile: '云端背景',
    })
    // 上面这些写入本身会记账，先清空，好单独验证「搬运不记账」
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    const imported = await importRecordsInto(db, guest)

    expect(imported).toBe(2) // 项目 + 节点；设置因为目标库已有而被跳过
    expect((await db.projects.get('guest-p1'))?.name).toBe('项目 guest-p1')
    expect((await db.nodes.get('guest-n1'))?.id).toBe('guest-n1')
    expect((await repositories.settings.load()).backgroundProfile).toBe('云端背景')
    // 搬运本身不记账（由 recordAllLocal 统一入队），否则首次登录会推一批重复变更
    expect(await sync.readOutbox()).toHaveLength(0)

    guest.close()
  })
})

describe('复习会话（本机数据）', () => {
  it('合并本机数据时同项目只留一份未完成会话，较早的转 ended 且内容不丢', async () => {
    const guest = new AppDatabase(`test-guest-${Math.random().toString(36).slice(2)}`)
    const guestRepos = createDexieRepositories(guest)

    // 账号库里已经有一份这个项目的未完成会话：上次在这台设备登录时留下的
    const existing = makeSession('p1', 'n-old', 1)
    await repositories.reviewSessions.save(existing)

    // 游客库：退出登录期间又复习了一轮（更近的一次活动）
    const fresh = makeSession('p1', 'n-new', 2)
    await guestRepos.reviewSessions.save(fresh)
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    await importRecordsInto(db, guest)

    const open = await openSessions(db, 'p1')
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(fresh.id)

    // 被顶掉的那份转 ended：内容保留（历史可查看），版本 +1 挡住内存里的旧副本复活
    const closed = await db.reviewSessions.get(existing.id)
    expect(closed).toMatchObject({ status: 'ended', open: 0, version: existing.version + 1 })
    expect(closed?.items[0].title).toBe('主题 n-old')
    expect(closed?.finishedAt).toBeTypeOf('number')

    // 搬运不记账：会话没有云同步实体，写进台账只会推一个服务端不认识的 entity
    expect(await sync.readOutbox()).toHaveLength(0)

    guest.close()
  })

  it('三个候选（目标库一份 + 游客库两份）也只留最近的一份 open', async () => {
    const guest = new AppDatabase(`test-guest-${Math.random().toString(36).slice(2)}`)

    await repositories.reviewSessions.save(makeSession('p1', 'n-in-target', 5))
    const middle = makeSession('p1', 'n-middle', 7)
    const newest = makeSession('p1', 'n-newest', 9)
    // 直接写表而不是走仓储：仓储会拦住「同一个库里两份 open」，而这里要造的正是
    // 「跨库各自一份 open」在合并时叠成多份的情形（历史脏数据同样长这样）
    await guest.reviewSessions.bulkPut([
      { ...middle, open: 1 },
      { ...newest, open: 1 },
    ])

    await importRecordsInto(db, guest)

    const open = await openSessions(db, 'p1')
    expect(open.map((row) => row.id)).toEqual([newest.id])
    expect((await db.reviewSessions.get(middle.id))?.status).toBe('ended')
    expect(await db.reviewSessions.count()).toBe(3)

    guest.close()
  })

  it('「以云端为准」清库时连会话一起清掉', async () => {
    await repositories.reviewSessions.save(makeSession('p1', 'n1', 1))

    await sync.clearLocalData()

    expect(await db.reviewSessions.count()).toBe(0)
  })

  it('远端项目 tombstone 级联清掉该项目的会话', async () => {
    await repositories.projects.create(makeProject('p1'))
    await repositories.reviewSessions.save(makeSession('p1', 'n1', 1))
    await repositories.reviewSessions.save(makeSession('p2', 'n2', 1))
    await sync.clearOutbox((await sync.readOutbox()).map((entry) => entry.seq as number))

    await sync.applyRemote(
      remote({ entity: 'project', id: 'p1', updatedAt: 200, deletedAt: 200, data: {} }),
    )

    expect(await openSessions(db, 'p1')).toHaveLength(0)
    // 别的项目的会话不受影响
    expect(await openSessions(db, 'p2')).toHaveLength(1)
  })
})