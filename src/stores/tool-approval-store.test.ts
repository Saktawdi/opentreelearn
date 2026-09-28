import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolApprovalPrompt } from '@/domain/agent/permissions'
import { useToolApprovalStore } from './tool-approval-store'

/**
 * 授权队列的语义测试。
 *
 * 队列不是为了「好看」：AI SDK 在一个 step 里会并发执行多个 tool call，
 * 只存一个 resolver 时后一次会把前一次冲掉，那一次的 Promise 永远不落地。
 * 这条回归就是钉死那个 bug 不许回来。
 */

const PROMPT: ToolApprovalPrompt = { title: { key: 'approval.askTitle.create_node' }, rows: [] }

const ask = (toolName: string) => useToolApprovalStore.getState().request(toolName, PROMPT)

describe('工具授权队列', () => {
  beforeEach(() => {
    useToolApprovalStore.setState({ pending: null, queued: [] })
  })

  it('挂起时 pending 有值，用户答完才落地', async () => {
    const running = ask('create_node')
    expect(useToolApprovalStore.getState().pending).toMatchObject({ toolName: 'create_node' })

    useToolApprovalStore.getState().respond('allow')
    expect(await running).toBe('allow')
    expect(useToolApprovalStore.getState().pending).toBeNull()
  })

  it('并发的多次调用排队结算，谁也不被顶掉', async () => {
    const first = ask('create_node')
    const second = ask('rename_node')
    const third = ask('tag_span')

    // 只有第一条在卡上，其余排队 —— 单 resolver 的老实现会把 first 冲掉
    expect(useToolApprovalStore.getState().pending).toMatchObject({ toolName: 'create_node' })
    expect(useToolApprovalStore.getState().queued).toHaveLength(2)

    useToolApprovalStore.getState().respond('allow')
    expect(await first).toBe('allow')
    expect(useToolApprovalStore.getState().pending).toMatchObject({ toolName: 'rename_node' })

    useToolApprovalStore.getState().respond('deny')
    expect(await second).toBe('deny')
    expect(useToolApprovalStore.getState().pending).toMatchObject({ toolName: 'tag_span' })

    useToolApprovalStore.getState().respond('allow')
    expect(await third).toBe('allow')
    expect(useToolApprovalStore.getState().pending).toBeNull()
    expect(useToolApprovalStore.getState().queued).toHaveLength(0)
  })

  it('cancelAll 把挂起与排队的全部判为拒绝：流必须能收尾', async () => {
    const first = ask('create_node')
    const second = ask('rename_node')

    useToolApprovalStore.getState().cancelAll()

    // 排队中的那些 resolve 只存在于各自 Promise 闭包里，存不下就永远结算不掉
    expect(await first).toBe('deny')
    expect(await second).toBe('deny')
    expect(useToolApprovalStore.getState().pending).toBeNull()
    expect(useToolApprovalStore.getState().queued).toHaveLength(0)
  })

  it('空状态下的 cancelAll / respond 不出错', () => {
    useToolApprovalStore.getState().cancelAll()
    useToolApprovalStore.getState().respond('allow')
    expect(useToolApprovalStore.getState().pending).toBeNull()
  })

  it('每次询问都拿到新 id：React 的 key 靠它区分卡片', () => {
    const a = useToolApprovalStore.getState().request('create_node', PROMPT)
    const firstId = useToolApprovalStore.getState().pending!.id
    const b = useToolApprovalStore.getState().request('rename_node', PROMPT)
    const secondId = useToolApprovalStore.getState().queued[0].id

    expect(firstId).not.toBe(secondId)
    useToolApprovalStore.getState().cancelAll()
    void a
    void b
  })
})
