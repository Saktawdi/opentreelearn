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