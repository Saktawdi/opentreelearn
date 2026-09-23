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