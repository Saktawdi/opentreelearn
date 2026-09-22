import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createDefaultSettings } from '@/domain/defaults'
import { makeNode } from '@/test/fixtures'
import { runFreeAskRequest } from '@/services/llm/free-ask'
import { useFreeAskStore } from './free-ask-store'
import { useSettingsStore } from './settings-store'
import { useWorkspaceStore } from './workspace-store'

vi.mock('@/services/llm/free-ask', () => ({ runFreeAskRequest: vi.fn() }))

const mocked = runFreeAskRequest as Mock

function okOutput(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    output: {
      requestId: 'req-1',
      text: '你今天学了《极限》',
      clean: '你今天学了《极限》',
      aborted: false,
      listed: 2,
      total: 2,
      ...overrides,
    },
  }
}

function seedWorkspace(projectId = 'p1') {
  useWorkspaceStore.setState({
    projectId,
    project: { id: projectId, name: '考研数学二', tags: [], createdAt: 1, updatedAt: 1 },
    projectSettings: null,
    nodes: [makeNode({ id: 'n1', title: '极限' })],
  })
}

/** 流式回调与状态落定跨几个微任务，等条件成立而不是猜时序（与 workspace-store.test 同法）。 */
async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!check() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  useFreeAskStore.getState().syncProject(null)
  useFreeAskStore.getState().reset()
  useSettingsStore.setState({ settings: createDefaultSettings(), loaded: true })
  seedWorkspace()
  mocked.mockReset()
})

describe('自由问答 store', () => {
  it('把提问与回答落成两条消息，第二次提问会带上历史', async () => {
    mocked.mockResolvedValueOnce(okOutput()).mockResolvedValueOnce(okOutput({ text: '接着答', clean: '接着答' }))

    await useFreeAskStore.getState().ask('今天我学了什么？')

    const first = useFreeAskStore.getState()
    expect(first.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(first.messages[0].text).toBe('今天我学了什么？')
    expect(first.messages[1].text).toBe('你今天学了《极限》')
    expect(first.streaming).toBeNull()
    expect(first.contextNote).toBe('本次参考了 2 / 2 个主题')
    // 首次提问时上下文里只有本轮问题
    expect(mocked.mock.calls[0][0].history).toEqual([])
    expect(mocked.mock.calls[0][0].nodes).toHaveLength(1)

    await useFreeAskStore.getState().ask('现在最该复习什么？')

    const second = mocked.mock.calls[1][0].history
    expect(second.map((message: { parts: Array<{ text: string }> }) => message.parts[0].text)).toEqual([
      '今天我学了什么？',
      '你今天学了《极限》',
    ])
  })

  it('失败时保留已生成的部分并单独给出错误，可再问一次', async () => {
    mocked.mockResolvedValueOnce({
      ok: false as const,
      failure: {
        requestId: 'req-2',
        partial: '你今天学了',
        message: '请求失败：网络不可用',
        hint: '稍后重试',
        aborted: false,
      },
    })

    await useFreeAskStore.getState().ask('今天我学了什么？')

    const state = useFreeAskStore.getState()
    expect(state.error).toBe('请求失败：网络不可用')
    expect(state.streaming).toBeNull()
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', incomplete: true })
    expect(state.messages.at(-1)?.text).toBe('你今天学了')
  })

  it('中途停止会把已生成的部分留下，并丢弃迟到的回包', async () => {
    mocked.mockImplementationOnce(
      async (input: { onDelta?: (delta: string) => void; signal: AbortSignal }) => {
        input.onDelta?.('你已经学完了《极限》')
        // 真实流式在被 abort 时也会返回：这里复现「回包比停止晚到」的时序
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve())
        })
        return okOutput({ text: '这段迟到内容不该出现', clean: '这段迟到内容不该出现' })
      },
    )

    const pending = useFreeAskStore.getState().ask('今天我学了什么？')
    await waitFor(() => useFreeAskStore.getState().streaming?.text === '你已经学完了《极限》')

    useFreeAskStore.getState().cancel()
    await pending

    const state = useFreeAskStore.getState()
    expect(state.streaming).toBeNull()
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', incomplete: true })
    expect(state.messages.at(-1)?.text).toBe('你已经学完了《极限》')
    expect(state.messages.some((message) => message.text.includes('迟到内容'))).toBe(false)
  })

  it('换项目即清空对话，避免上一个项目的主题串到新项目', async () => {
    mocked.mockResolvedValueOnce(okOutput())
    await useFreeAskStore.getState().ask('今天我学了什么？')
    expect(useFreeAskStore.getState().messages).toHaveLength(2)

    useFreeAskStore.getState().syncProject('p2')
    expect(useFreeAskStore.getState().messages).toEqual([])
    expect(useFreeAskStore.getState().contextNote).toBeNull()

    // 同一项目内开关面板不会丢对话
    useFreeAskStore.getState().syncProject('p2')
    expect(useFreeAskStore.getState().projectId).toBe('p2')
  })
})