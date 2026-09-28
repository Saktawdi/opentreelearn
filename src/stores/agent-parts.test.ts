import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Project } from '@/domain/models'
import { getDatabase, getRepositories } from '@/data'
import i18n from '@/i18n'
import { createDefaultSettings } from '@/domain/defaults'
import { messageText, messageToolParts } from '@/domain/messages'
import { useSettingsStore } from './settings-store'
import { useToolApprovalStore } from './tool-approval-store'
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

  vi.mock('@/services/llm/derive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/llm/derive')>()
    return {
      ...actual,
      generateSummary: async () => ({
        summary: '已掌握牛顿第二定律公式',
        mastery: 85,
        weakPoints: [],
      }),
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
      summaryModelRef: { providerId: 'prov1', modelId: 'test-model' },
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
describe('写工具（无条件注册 + 逐次授权 + 撤销）', () => {
  function toolsOfLastCall(): Record<string, unknown> {
    return ((llm.calls.at(-1) as { tools?: Record<string, unknown> }).tools ?? {})
  }

  /**
   * 调一个需授权的工具：闸门会挂起等用户，这里替用户点「允许」。
   *
   * 之所以要这样包一层：写工具现在**一律注册**、执行前必问，测试里直接
   * `await execute(...)` 会永远等在授权卡上。
   */
  async function allowAndRun(
    execute: (input: unknown, options: unknown) => Promise<string>,
    input: unknown,
  ): Promise<string> {
    const running = execute(input, {})
    await vi.waitFor(() => expect(useToolApprovalStore.getState().pending).not.toBeNull())
    useToolApprovalStore.getState().respond('allow')
    return running
  }

  it('registers write tools by default and tells the model they need approval', async () => {
    await seed()
    await useWorkspaceStore.getState().startRootNode('问题')

    const tools = toolsOfLastCall()
    expect(tools.search_nodes).toBeDefined()
    expect(tools.create_node).toBeDefined()
    expect(tools.rename_node).toBeDefined()
    expect(tools.tag_span).toBeDefined()
    // 破坏性操作不提供
    expect(tools.archive_node).toBeUndefined()
    expect(tools.delete_node).toBeUndefined()

    const system = (llm.calls.at(-1) as { system?: string }).system ?? ''
    expect(system).toContain('改动这棵树的规则')
    // 「要先问用户」必须写进提示：不然模型被拒后会换个参数重试
    expect(system).toContain('先向用户申请授权')
  })

  it('creates a node through the real action path and offers an undo that removes it', async () => {
    await seed()
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')

    const tools = toolsOfLastCall() as { create_node: { execute: (i: unknown, o: unknown) => Promise<string> } }
    const result = await allowAndRun(tools.create_node.execute, {
      kind: 'child',
      title: '拆解一',
      seed: '什么叫守恒？',
    })
    expect(result).toContain(i18n.t('common:agent.nodeCreated', { title: '拆解一' }))

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
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')

    const tools = toolsOfLastCall() as { rename_node: { execute: (i: unknown, o: unknown) => Promise<string> } }
    await allowAndRun(tools.rename_node.execute, { nodeId: root!.id, title: '动量与冲量' })
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
    const root = await useWorkspaceStore.getState().startRootNode('忽略竖直方向会怎样？')
    const messageId = (useWorkspaceStore.getState().messagesByNode[root!.id] ?? [])[0].id

    const tools = toolsOfLastCall() as { tag_span: { execute: (i: unknown, o: unknown) => Promise<string> } }
    const ok = await allowAndRun(tools.tag_span.execute, {
      messageId,
      quote: '忽略竖直方向',
      labels: ['mistake'],
    })
    expect(ok).toContain(i18n.t('common:agent.taggedDone', { labels: '[错题]' }))

    const note = (useWorkspaceStore.getState().notesByMessage[messageId] ?? [])[0]
    expect(note).toMatchObject({ labels: ['mistake'], start: 0, end: 6 })

    // 原文对不上就如实拒绝：宁可不标，也不要标到别处
    const miss = await allowAndRun(tools.tag_span.execute, {
      messageId,
      quote: '这句话不在正文里',
      labels: ['mistake'],
    })
    expect(miss).toContain('找不到这段原文')

    await useWorkspaceStore.getState().undoAgentChange()
    expect(await getRepositories().notes.listByProject('p1')).toEqual([])
  })

  it('denies the write and tells the model to report it, without touching the tree', async () => {
    await seed()
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')

    const tools = toolsOfLastCall() as { rename_node: { execute: (i: unknown, o: unknown) => Promise<string> } }
    const running = tools.rename_node.execute({ nodeId: root!.id, title: '不该被改' }, {})
    await vi.waitFor(() =>
      expect(useToolApprovalStore.getState().pending).toMatchObject({ toolName: 'rename_node' }),
    )
    useToolApprovalStore.getState().respond('deny')

    const result = await running
    expect(result).toContain('用户拒绝了这次授权')
    // 明确告诉模型别绕道重试，否则它会换个参数再举一次手
    expect(result).toContain('不要换个参数')
    expect(useWorkspaceStore.getState().nodes.find((item) => item.id === root!.id)?.title).toBe(
      '动量守恒',
    )
    expect(useToolApprovalStore.getState().pending).toBeNull()
  })

  it('blocks on approval instead of running the write immediately', async () => {
    await seed()
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')

    const tools = toolsOfLastCall() as { rename_node: { execute: (i: unknown, o: unknown) => Promise<string> } }
    let settled = false
    const running = tools.rename_node.execute({ nodeId: root!.id, title: '先别改' }, {}).then(
      (value) => {
        settled = true
        return value
      },
    )

    await vi.waitFor(() => expect(useToolApprovalStore.getState().pending).not.toBeNull())
    // 关键：还没点就不许动数据
    expect(settled).toBe(false)
    expect(useWorkspaceStore.getState().nodes.find((item) => item.id === root!.id)?.title).toBe(
      '动量守恒',
    )

    useToolApprovalStore.getState().respond('allow')
    await running
    expect(useWorkspaceStore.getState().nodes.find((item) => item.id === root!.id)?.title).toBe(
      '先别改',
    )
  })

  it('shows the target node and the reason on the approval card', async () => {
    await seed()
    const root = await useWorkspaceStore.getState().startRootNode('牛顿第二定律')

    const tools = toolsOfLastCall() as { update_assessment: { execute: (i: unknown, o: unknown) => Promise<string> } }
    const running = tools.update_assessment.execute(
      { nodeId: root!.id, reason: '已掌握牛顿第二定律公式' },
      {},
    )
    await vi.waitFor(() => expect(useToolApprovalStore.getState().pending).not.toBeNull())

    const prompt = useToolApprovalStore.getState().pending!.prompt
    // 卡片是通用的：内容由域层出 i18n 键 + 插值，组件照着渲染
    expect(prompt.title.key).toBe('approval.askTitle.update_assessment')
    expect(prompt.rows.map((row) => row.value.key)).toContain('approval.value.node')
    expect(prompt.rows.find((row) => row.value.key === 'approval.value.node')?.value.params)
      .toEqual({ title: '牛顿第二定律' })
    expect(prompt.reason).toBe('已掌握牛顿第二定律公式')

    useToolApprovalStore.getState().respond('deny')
    await running
  })

  it('applies the project-level auto-allow preference to later calls', async () => {
    await seed()
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')
    // 偏好是项目级设置，不是运行时内存
    await useWorkspaceStore.getState().updateProjectSettings({ agentToolPermission: 'always_allow' })
    expect(useWorkspaceStore.getState().projectSettings?.agentToolPermission).toBe('always_allow')

    await useWorkspaceStore.getState().sendMessage(root!.id, [{ type: 'text', text: '再问' }])
    const tools = toolsOfLastCall() as { rename_node: { execute: (i: unknown, o: unknown) => Promise<string> } }

    // 自动允许：直接跑完，不挂起
    const res = await tools.rename_node.execute({ nodeId: root!.id, title: '免打扰' }, {})
    expect(res).toContain('免打扰')
    expect(useToolApprovalStore.getState().pending).toBeNull()
    expect(useWorkspaceStore.getState().nodes.find((item) => item.id === root!.id)?.title).toBe(
      '免打扰',
    )
  })

  it('treats read tools inside the open zone as needing no approval', async () => {
    await seed()
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')

    const tools = toolsOfLastCall() as { get_node: { execute: (i: unknown, o: unknown) => Promise<string> } }
    // 开放区 = 当前项目：区内检索是本产品的主力场景，绝不能弹卡
    const res = await tools.get_node.execute({ nodeId: root!.id }, {})
    expect(res).toContain('动量守恒')
    expect(useToolApprovalStore.getState().pending).toBeNull()
  })

  it('updates the assessment and offers an undo once approved', async () => {
    await seed()
    const root = await useWorkspaceStore.getState().startRootNode('牛顿第二定律')
    // 评估要求可见路径里至少一轮问答：补上一条回答
    const assistantMsg = {
      id: 'm2',
      nodeId: root!.id,
      projectId: 'p1',
      role: 'assistant' as const,
      parts: [{ type: 'text' as const, text: 'F=ma' }],
      createdAt: Date.now(),
    }
    await getRepositories().messages.create(assistantMsg)
    useWorkspaceStore.setState((draft) => {
      draft.messagesByNode[root!.id].push(assistantMsg)
    })

    const tools = toolsOfLastCall() as { update_assessment: { execute: (i: unknown, o: unknown) => Promise<string> } }
    const running = tools.update_assessment.execute(
      { nodeId: root!.id, reason: '学习者已掌握牛顿第二定律公式' },
      {},
    )
    await vi.waitFor(() => expect(useToolApprovalStore.getState().pending).not.toBeNull())
    useToolApprovalStore.getState().respond('allow')
    await running

    expect(useToolApprovalStore.getState().pending).toBeNull()
    expect(useWorkspaceStore.getState().nodes.find((item) => item.id === root!.id)?.mastery)
      .toMatchObject({ score: 85 })

    expect(useWorkspaceStore.getState().agentChange?.label).toContain('牛顿第二定律')
    await useWorkspaceStore.getState().undoAgentChange()
    expect(useWorkspaceStore.getState().agentChange).toBeNull()
  })

  it('cancels a pending approval when the user stops the round', async () => {
    await seed()
    const root = await useWorkspaceStore.getState().startRootNode('动量守恒')

    const tools = toolsOfLastCall() as { rename_node: { execute: (i: unknown, o: unknown) => Promise<string> } }
    const running = tools.rename_node.execute({ nodeId: root!.id, title: '停掉' }, {})
    await vi.waitFor(() => expect(useToolApprovalStore.getState().pending).not.toBeNull())

    useWorkspaceStore.getState().stopStreaming()

    // 中止时必须把挂起的那次结算掉：否则 Promise 永远不落地，卡片也撤不掉
    expect(await running).toContain('用户拒绝了这次授权')
    expect(useToolApprovalStore.getState().pending).toBeNull()
    expect(useWorkspaceStore.getState().nodes.find((item) => item.id === root!.id)?.title).toBe(
      '动量守恒',
    )
  })
})
