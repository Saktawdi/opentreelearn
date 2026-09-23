import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Project } from '@/domain/models'
import { getDatabase, getRepositories } from '@/data'
import { createDefaultSettings } from '@/domain/defaults'
import { messageText, messageToolParts } from '@/domain/messages'
import { useSettingsStore } from './settings-store'
import { useWorkspaceStore } from './workspace-store'

/**
 * 工具记录的落库行为（P-C1）。
 *
 * 只把 `streamReply` 换成桩：其余（模型解析、上下文组装、落库）都走真实实现 ——
 * 要验的正是「流式期间的举手与结果，最终以什么形状进了消息表」。
 */
const llm = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  plan: { text: '答案是：动量守恒。', toolCalls: 0, hitStepLimit: false } as {
    text: string
    toolCalls: number
    hitStepLimit: boolean
  },
  tools: [] as Array<{ callId: string; name: string; input: unknown; output?: string; error?: string }>,
  halfRecord: null as null | { callId: string },
}))

vi.mock('@/services/llm/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/llm/chat')>()
  return {
    ...actual,
    streamReply: async (params: unknown) => {
      const options = params as {
        onDelta?: (delta: string) => void
        onToolCall?: (activity: { callId: string; name: string; input: unknown }) => void
        onToolResult?: (outcome: { callId: string; name: string; output?: string; error?: string }) => void
      }
      llm.calls.push(options as Record<string, unknown>)

      for (const tool of llm.tools) {
        options.onToolCall?.({ callId: tool.callId, name: tool.name, input: tool.input })
        options.onToolResult?.({
          callId: tool.callId,
          name: tool.name,
          ...(tool.output !== undefined ? { output: tool.output } : {}),
          ...(tool.error !== undefined ? { error: tool.error } : {}),
        })
      }
      // 举了手但没等到结果：中断的写照
      if (llm.halfRecord) {
        options.onToolCall?.({ callId: llm.halfRecord.callId, name: 'search_nodes', input: {} })
      }

      options.onDelta?.(llm.plan.text)
      return {
        text: llm.plan.text,
        aborted: false,
        toolCalls: llm.plan.toolCalls,
        hitStepLimit: llm.plan.hitStepLimit,
      }
    },
  }
})

async function seed(): Promise<void> {
  const project: Project = { id: 'p1', name: '线性代数', tags: [], createdAt: 1, updatedAt: 1 }
  await getRepositories().projects.create(project)
  useSettingsStore.setState({
    settings: {
      ...createDefaultSettings(),
      providers: [
        {
          id: 'prov1',
          label: '本地测试',
          kind: 'openai',
          apiKey: 'test-key',
          baseURL: '/local-v1',
          models: ['test-model'],
        },
      ],
      defaultChatModelRef: { providerId: 'prov1', modelId: 'test-model' },
    },
    loaded: true,
  })
  await useWorkspaceStore.getState().openProject('p1')
}

beforeEach(async () => {
  const db = getDatabase()
  db.close()
  await db.delete()
  await db.open()
  llm.calls = []
  llm.tools = []
  llm.halfRecord = null
  llm.plan = { text: '答案是：动量守恒。', toolCalls: 0, hitStepLimit: false }
  useSettingsStore.setState({ settings: createDefaultSettings(), loaded: true })
  useWorkspaceStore.getState().reset()
})

describe('工具记录的落库形状', () => {
  it('persists completed tool calls before the text, and drops half records', async () => {
    await seed()
    llm.tools = [
      { callId: 'c1', name: 'search_nodes', input: { query: '动量' }, output: '查到《动量守恒》' },
      { callId: 'c2', name: 'get_node', input: {}, error: '节点不存在' },
    ]
    llm.halfRecord = { callId: 'c3' }
    llm.plan = { text: '你在《动量守恒》里学过。', toolCalls: 2, hitStepLimit: false }

    const node = await useWorkspaceStore.getState().startRootNode('我之前在哪学过动量守恒？')
    const messages = useWorkspaceStore.getState().messagesByNode[node!.id] ?? []
    const answer = messages.find((message) => message.role === 'assistant')!

    const tools = messageToolParts(answer)
    // c3 是半截记录（举手无结果）：落库会撕裂配对，必须丢掉
    expect(tools.map((part) => part.callId)).toEqual(['c1', 'c2'])
    expect(tools[0]).toMatchObject({ name: 'search_nodes', output: '查到《动量守恒》' })
    expect(tools[1]).toMatchObject({ name: 'get_node', error: '节点不存在' })

    // 工具记录排在正文之前，正文仍然只有模型写的那些字
    expect(answer.parts.at(-1)).toEqual({ type: 'text', text: '你在《动量守恒》里学过。' })
    expect(messageText(answer)).toBe('你在《动量守恒》里学过。')

    // 真的写进了消息表（刷新后仍在），并且台账也记了一笔
    const stored = await getRepositories().messages.get(answer.id)
    expect(messageToolParts(stored as Message)).toHaveLength(2)
  })

  it('keeps tool records on an interrupted answer, but never a half record', async () => {
    await seed()
    llm.tools = [{ callId: 'c1', name: 'search_notes', input: {}, output: '一条错题' }]
    llm.halfRecord = { callId: 'c2' }

    const node = await useWorkspaceStore.getState().startRootNode('我有哪些错题？')
    const answer = (useWorkspaceStore.getState().messagesByNode[node!.id] ?? []).find(
      (message) => message.role === 'assistant',
    )!

    expect(messageToolParts(answer).map((part) => part.callId)).toEqual(['c1'])
  })

  it('attaches tools and the tool rules only when the provider is not marked unsupported', async () => {
    await seed()
    const node = await useWorkspaceStore.getState().startRootNode('问问')
    const withTools = llm.calls.at(-1) as { tools?: unknown; system?: string }
    expect(withTools.tools).toBeDefined()
    expect(withTools.system).toContain('## 工具使用')

    // 明确探测到不支持 ⇒ 完全不带工具，系统提示也不提工具
    const settings = useSettingsStore.getState().settings
    useSettingsStore.setState({
      settings: {
        ...settings,
        providers: settings.providers.map((provider) => ({
          ...provider,
          capabilities: { tools: false },
        })),
      },
    })
    await useWorkspaceStore.getState().sendMessage(node!.id, [{ type: 'text', text: '再问' }])
    const withoutTools = llm.calls.at(-1) as { tools?: unknown; system?: string }
    expect(withoutTools.tools).toBeUndefined()
    expect(withoutTools.system).not.toContain('## 工具使用')
  })
})
describe('写工具（默认关闭 + 撤销）', () => {
  /** 让本轮的工具集里出现写工具：能力位支持 + 项目开关打开。 */
  async function enableWrite(): Promise<void> {
    useWorkspaceStore.setState((draft) => {
      draft.projectSettings = { projectId: 'p1', agentWriteEnabled: true }
    })
  }

  function toolsOfLastCall(): Record<string, unknown> {
    return ((llm.calls.at(-1) as { tools?: Record<string, unknown> }).tools ?? {})
  }

  it('默认只给只读工具，写工具要等项目开关打开', async () => {
    await seed()
    const node = await useWorkspaceStore.getState().startRootNode('问题')

    const readOnly = toolsOfLastCall()
    expect(readOnly.search_nodes).toBeDefined()
    expect(readOnly.create_node).toBeUndefined()

    await enableWrite()
    await useWorkspaceStore.getState().sendMessage(node!.id, [{ type: 'text', text: '再问' }])
    const withWrite = toolsOfLastCall()
    expect(withWrite.create_node).toBeDefined()
    expect(withWrite.rename_node).toBeDefined()
    expect(withWrite.tag_span).toBeDefined()
    // 破坏性操作不提供
    expect(withWrite.archive_node).toBeUndefined()
    expect(withWrite.delete_node).toBeUndefined()

    const system = (llm.calls.at(-1) as { system?: string }).system ?? ''
    expect(system).toContain('改动这棵树的规则')
  })

  it('creates a node through the real action path and offers an undo that removes it', async () => {
    await seed()
    await enableWrite()
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')

    const tools = toolsOfLastCall() as { create_node: { execute: (i: unknown, o: unknown) => Promise<string> } }
    const result = await tools.create_node.execute(
      { kind: 'child', title: '拆解一', seed: '什么叫守恒？' },
      {},
    )
    expect(result).toContain('新建了节点《拆解一》')

    const state = useWorkspaceStore.getState()
    const created = state.nodes.find((item) => item.title === '拆解一')!
    expect(created.parentId).toBe(root!.id)
    // seed 落成第一条提问，但不触发新一轮模型调用
    expect((state.messagesByNode[created.id] ?? []).map((message) => message.role)).toEqual(['user'])
    expect(llm.calls).toHaveLength(1)

    expect(state.agentChange?.label).toContain('拆解一')
    await state.undoAgentChange()
    const after = useWorkspaceStore.getState()
    expect(after.nodes.some((item) => item.title === '拆解一')).toBe(false)
    expect(after.agentChange).toBeNull()
    expect(await getRepositories().nodes.get(created.id)).toBeUndefined()
  })

  it('renames a node and restores the previous title on undo', async () => {
    await seed()
    await enableWrite()
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')

    const tools = toolsOfLastCall() as { rename_node: { execute: (i: unknown, o: unknown) => Promise<string> } }
    await tools.rename_node.execute({ nodeId: root!.id, title: '动量与冲量' }, {})
    expect(useWorkspaceStore.getState().nodes.find((item) => item.id === root!.id)?.title).toBe(
      '动量与冲量',
    )

    await useWorkspaceStore.getState().undoAgentChange()
    expect(useWorkspaceStore.getState().nodes.find((item) => item.id === root!.id)?.title).toBe(
      '动量守恒',
    )
  })

  it('tags a span found in the message text and refuses a quote that is not there', async () => {
    await seed()
    await enableWrite()
    const root = await useWorkspaceStore.getState().startRootNode('忽略竖直方向会怎样？')
    const messageId = (useWorkspaceStore.getState().messagesByNode[root!.id] ?? [])[0].id

    const tools = toolsOfLastCall() as { tag_span: { execute: (i: unknown, o: unknown) => Promise<string> } }
    const ok = await tools.tag_span.execute(
      { messageId, quote: '忽略竖直方向', labels: ['mistake'] },
      {},
    )
    expect(ok).toContain('已打标签 [错题]')

    const note = (useWorkspaceStore.getState().notesByMessage[messageId] ?? [])[0]
    expect(note).toMatchObject({ labels: ['mistake'], start: 0, end: 6 })

    // 原文对不上就如实拒绝：宁可不标，也不要标到别处
    const miss = await tools.tag_span.execute(
      { messageId, quote: '这句话不在正文里', labels: ['mistake'] },
      {},
    )
    expect(miss).toContain('找不到这段原文')

    await useWorkspaceStore.getState().undoAgentChange()
    expect(await getRepositories().notes.listByProject('p1')).toEqual([])
  })
})
