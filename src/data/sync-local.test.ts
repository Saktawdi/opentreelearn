import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Node, Project } from '@/domain/models'
import { createDefaultSettings } from '@/domain/defaults'
import type { WireChange } from '@/domain/sync'
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

    const outcome = await sync.applyRemote(
      remote({ entity: 'project', id: 'p1', deletedAt: 200, data: {} }),
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

  it('全局设置按 provider id 保留本机 API Key（密钥从来不上云）', async () => {
    await repositories.settings.save({
      ...createDefaultSettings(),
      updatedAt: 100,
      providers: [
        { id: 'prov-1', label: '本机配置', kind: 'openai', apiKey: 'sk-local-secret', models: ['gpt-4o'] },
      ],
    })

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