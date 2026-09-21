import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@/domain/models'
import { getDatabase, getRepositories } from '@/data'
import { createDefaultSettings } from '@/domain/defaults'
import { useSettingsStore } from './settings-store'
import { useWorkspaceStore } from './workspace-store'

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
})

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