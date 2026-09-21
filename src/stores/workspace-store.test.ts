import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/domain/models'
import { getDatabase, getRepositories } from '@/data'
import { createDefaultSettings } from '@/domain/defaults'
import { useSettingsStore } from './settings-store'
import { useWorkspaceStore } from './workspace-store'

const llm = vi.hoisted(() => ({
  summaryCalls: 0,
  resolveSummary: null as null | ((value: string | null) => void),
}))

vi.mock('@/services/llm/derive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/llm/derive')>()
  return {
    ...actual,
    generateTitle: async () => null,
    generateSummary: () => {
      llm.summaryCalls += 1
      return new Promise<string | null>((resolve) => {
        llm.resolveSummary = resolve
      })
    },
  }
})

async function seedProject(): Promise<void> {
  const project: Project = {
    id: 'p1',
    name: '线性代数',
    tags: ['数学'],
    createdAt: 1,
    updatedAt: 1,
  }
  await getRepositories().projects.create(project)
  await useWorkspaceStore.getState().openProject('p1')
}

beforeEach(async () => {
  const db = getDatabase()
  db.close()
  await db.delete()
  await db.open()
  useSettingsStore.setState({ settings: createDefaultSettings(), loaded: true })
  useWorkspaceStore.getState().reset()
  llm.summaryCalls = 0
  llm.resolveSummary = null
})

/** 摘要模型要建起 LanguageModel 实例，会跨几个微任务，等状态落定而不是猜时序。 */
async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!check() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('workspace store', () => {
  it('opens a project and starts the root node from the first question', async () => {
    await seedProject()
    expect(useWorkspaceStore.getState().project?.name).toBe('线性代数')
    expect(useWorkspaceStore.getState().nodes).toHaveLength(0)

    const node = await useWorkspaceStore.getState().startRootNode('什么是特征值？')
    expect(node).not.toBeNull()

    const state = useWorkspaceStore.getState()
    expect(state.nodes).toHaveLength(1)
    expect(state.nodes[0].title).toBe('什么是特征值？')
    expect(state.selectedNodeId).toBe(node?.id)

    const messages = state.messagesByNode[node!.id] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')

    expect(state.streaming?.error).toContain('尚未配置')
  })

  it('creates diverge, child and branch nodes with the expected shape', async () => {
    await seedProject()
    const root = await useWorkspaceStore.getState().startRootNode('梯度是什么？')
    const firstMessageId = (useWorkspaceStore.getState().messagesByNode[root!.id] ?? [])[0].id
    const store = () => useWorkspaceStore.getState()

    const child = await store().applyAction('child', root!.id)
    expect(child?.parentId).toBe(root!.id)
    expect(child?.forkFrom).toBeNull()

    const branch = await store().applyAction('branch', root!.id)
    expect(branch?.parentId).toBe(root!.id)
    expect(branch?.forkFrom).toEqual({ nodeId: root!.id, messageId: firstMessageId })

    const diverge = await store().applyAction('diverge', root!.id)
    expect(diverge?.parentId).toBeNull()
    expect(diverge?.forkFrom).toEqual({ nodeId: root!.id, messageId: firstMessageId })

    const blankBranch = await store().applyAction('branch', child!.id)
    expect(blankBranch?.parentId).toBe(child!.id)
    expect(blankBranch?.forkFrom).toBeNull()

    const nodeIds = store().nodes.map((node) => node.id).sort()
    expect(nodeIds).toEqual(
      [root!.id, child!.id, branch!.id, diverge!.id, blankBranch!.id].sort(),
    )
  })

  it('persists a manual position, then clears it on relayout', async () => {
    await seedProject()
    const root = await useWorkspaceStore.getState().startRootNode('问题')

    await useWorkspaceStore.getState().setNodePosition(root!.id, { x: 120, y: 80 })
    expect((await getRepositories().nodes.get(root!.id))?.position).toEqual({ x: 120, y: 80 })

    await useWorkspaceStore.getState().relayout()
    expect((await getRepositories().nodes.get(root!.id))?.position).toBeNull()
  })

  it('deletes a node together with its subtree and messages', async () => {
    await seedProject()
    const root = await useWorkspaceStore.getState().startRootNode('问题')
    const child = await useWorkspaceStore.getState().applyAction('child', root!.id)
    const grandChild = await useWorkspaceStore.getState().applyAction('child', child!.id)

    await useWorkspaceStore.getState().deleteNode(child!.id)

    const state = useWorkspaceStore.getState()
    expect(state.nodes.map((node) => node.id)).toEqual([root!.id])
    expect(state.messagesByNode[child!.id]).toBeUndefined()

    expect(await getRepositories().nodes.get(grandChild!.id)).toBeUndefined()
    expect((await getRepositories().nodes.get(root!.id))?.id).toBe(root!.id)
  })

  it('archives the whole subtree', async () => {
    await seedProject()
    const root = await useWorkspaceStore.getState().startRootNode('问题')
    const child = await useWorkspaceStore.getState().applyAction('child', root!.id)

    await useWorkspaceStore.getState().archiveNode(root!.id)

    const state = useWorkspaceStore.getState()
    expect(state.nodes.every((node) => node.status === 'archived')).toBe(true)
    expect((await getRepositories().nodes.get(child!.id))?.status).toBe('archived')
  })
})

describe('summary generation', () => {
  async function seedSummaryModel(): Promise<void> {
    const settings = createDefaultSettings()
    settings.providers = [
      {
        id: 'prov1',
        label: '本地测试',
        kind: 'openai',
        apiKey: 'test-key',
        // 相对 Base URL：测试跑在 node 环境，没有 window 可拼同源代理前缀
        baseURL: '/local-v1',
        models: ['test-model'],
      },
    ]
    settings.summaryModelRef = { providerId: 'prov1', modelId: 'test-model' }
    useSettingsStore.setState({ settings, loaded: true })
  }

  /** 摘要至少要有来有回两条消息才会生成。 */
  async function seedConversation(nodeId: string): Promise<void> {
    await getRepositories().messages.create({
      id: 'm-assistant',
      nodeId,
      projectId: 'p1',
      role: 'assistant',
      parts: [{ type: 'text', text: '我们先把不定积分的分部积分法推一遍。' }],
      createdAt: 2,
    })
    await useWorkspaceStore.getState().openProject('p1')
  }

  it('summarizes only when asked, flagging the node while it runs', async () => {
    await seedProject()
    await seedSummaryModel()
    const root = await useWorkspaceStore.getState().startRootNode('什么是特征值？')
    await seedConversation(root!.id)
    const store = () => useWorkspaceStore.getState()

    // 发消息本身不再触发摘要：只有手动调用才会走 generateSummary
    await store().sendMessage(root!.id, [{ type: 'text', text: '再讲讲' }])
    expect(llm.summaryCalls).toBe(0)
    expect(store().summarizingNodeIds).toEqual([])

    const pending = store().refreshSummary(root!.id)
    await waitFor(() => store().summarizingNodeIds.includes(root!.id))
    expect(store().summarizingNodeIds).toContain(root!.id)

    await waitFor(() => llm.resolveSummary !== null)
    llm.resolveSummary?.('已掌握特征值定义，计算细节仍需加强')
    await pending

    expect(store().summarizingNodeIds).not.toContain(root!.id)
    expect(store().nodes.find((node) => node.id === root!.id)?.summary).toBe(
      '已掌握特征值定义，计算细节仍需加强',
    )
    expect((await getRepositories().nodes.get(root!.id))?.summary).toBe(
      '已掌握特征值定义，计算细节仍需加强',
    )
  })

  it('clears the flag when the model call fails', async () => {
    await seedProject()
    await seedSummaryModel()
    const root = await useWorkspaceStore.getState().startRootNode('问题')
    await seedConversation(root!.id)
    const store = () => useWorkspaceStore.getState()

    const pending = store().refreshSummary(root!.id)
    await waitFor(() => llm.resolveSummary !== null)
    llm.resolveSummary?.(null)
    await pending

    expect(store().summarizingNodeIds).not.toContain(root!.id)
    expect(store().nodes.find((node) => node.id === root!.id)?.summary).toBeUndefined()
  })
})

describe('note actions', () => {
  it('adds, edits and removes notes, persisting every step', async () => {
    await seedProject()
    const root = await useWorkspaceStore.getState().startRootNode('什么是特征值？')
    const messageId = (useWorkspaceStore.getState().messagesByNode[root!.id] ?? [])[0].id
    const store = () => useWorkspaceStore.getState()

    const note = await store().addNote({
      nodeId: root!.id,
      messageId,
      kind: 'annotation',
      quote: '特征值',
      start: 2,
      end: 5,
      body: '  重点  ',
    })

    expect(note?.body).toBe('重点')
    expect(store().notesByMessage[messageId]).toHaveLength(1)
    expect(await getRepositories().notes.listByProject('p1')).toHaveLength(1)

    await store().updateNote(note!.id, { body: '换个说法' })
    expect(store().notesByMessage[messageId][0].body).toBe('换个说法')
    expect((await getRepositories().notes.listByProject('p1'))[0].body).toBe('换个说法')

    // 清空批注：body 要真的从记录里消失，而不是留一个空串骗过 `note.body` 的判断
    await store().updateNote(note!.id, { body: '   ' })
    expect(store().notesByMessage[messageId][0].body).toBeUndefined()
    expect((await getRepositories().notes.listByProject('p1'))[0].body).toBeUndefined()

    await store().removeNote(note!.id)
    expect(store().notesByMessage[messageId]).toBeUndefined()
    expect(await getRepositories().notes.listByProject('p1')).toEqual([])
  })

  it('keeps a message’s notes ordered by their position in the text', async () => {
    await seedProject()
    const root = await useWorkspaceStore.getState().startRootNode('问题')
    const messageId = (useWorkspaceStore.getState().messagesByNode[root!.id] ?? [])[0].id
    const store = () => useWorkspaceStore.getState()

    await store().addNote({ nodeId: root!.id, messageId, kind: 'highlight', quote: '后', start: 10, end: 11 })
    await store().addNote({ nodeId: root!.id, messageId, kind: 'annotation', quote: '前', start: 2, end: 3 })

    expect(store().notesByMessage[messageId].map((note) => note.quote)).toEqual(['前', '后'])
  })

  it('reloads notes with the project and drops them when the node goes away', async () => {
    await seedProject()
    const root = await useWorkspaceStore.getState().startRootNode('问题')
    const messageId = (useWorkspaceStore.getState().messagesByNode[root!.id] ?? [])[0].id

    await useWorkspaceStore.getState().addNote({
      nodeId: root!.id,
      messageId,
      kind: 'highlight',
      quote: '问题',
      start: 0,
      end: 2,
    })

    await useWorkspaceStore.getState().openProject('p1')
    expect(useWorkspaceStore.getState().notesByMessage[messageId]).toHaveLength(1)

    await useWorkspaceStore.getState().deleteNode(root!.id)
    expect(useWorkspaceStore.getState().notesByMessage[messageId]).toBeUndefined()
    expect(await getRepositories().notes.listByProject('p1')).toEqual([])
  })
})