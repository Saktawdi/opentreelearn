import { create } from 'zustand'
import { newId } from '@/lib/id'
import type { ToolApprovalPrompt, ToolPermissionDecision } from '@/domain/agent/permissions'

/**
 * 工具授权的**阻塞式询问**：Agent 举手 → 这里挂起 → 卡片问用户 → 结算 → 继续。
 *
 * 为什么要独立一个 store，而不是塞进 workspace-store：
 * 1. 授权是横切关注点（对话页要用，将来别的入口也要用），挂在 workspace-store
 *    上会让「问不问得到」取决于用户从哪个入口进来；
 * 2. workspace-store 已经 1500 行，再塞一个跨轮次存活的 Promise 状态进去，
 *    两种生命周期（项目状态 vs 单次工具调用）会互相污染。
 *
 * 队列而非单个 resolver：AI SDK 会在一个 step 里并发执行多个 tool call。
 * 存一个 `currentResolver` 时第二次调用会把第一次的直接冲掉 —— 那一次的
 * Promise 永远不 resolve，工具调用悬死到用户放弃这一轮。
 */

export interface ToolApprovalRequest {
  id: string
  /** 模型调用的工具名：回给模型的拒绝说明与排查都要用 */
  toolName: string
  /** 卡片要展示的内容（域层只给键，渲染时才解析） */
  prompt: ToolApprovalPrompt
}

interface ToolApprovalState {
  /** 正在卡片上等的那一条 */
  pending: ToolApprovalRequest | null
  /** 排在后面的（卡片上会显示「还有 N 项等待」） */
  queued: ToolApprovalRequest[]
  /** 挂起一次询问，返回用户的裁决 */
  request: (toolName: string, prompt: ToolApprovalPrompt) => Promise<ToolPermissionDecision>
  /** 结算当前一条；后面还有就顶上 */
  respond: (decision: ToolPermissionDecision) => void
  /** 把当前 + 排队的全部判为拒绝并 resolve（中止 / 切节点 / 切项目时调用） */
  cancelAll: () => void
}

/**
 * resolve 回调按 id 存，不挂在 store 状态上。
 *
 * 两点考虑：状态里塞函数会让 devtools 快照与结构比对变难看；更关键的是
 * `cancelAll` 必须能结算**排队中的**那些 —— 它们的 resolve 只存在于各自
 * Promise 的闭包里，不存下来就永远够不着，流也就永远收不了尾。
 */
const resolvers = new Map<string, (decision: ToolPermissionDecision) => void>()

function settle(id: string, decision: ToolPermissionDecision): void {
  const resolve = resolvers.get(id)
  if (!resolve) return
  resolvers.delete(id)
  resolve(decision)
}

export const useToolApprovalStore = create<ToolApprovalState>((set, get) => ({
  pending: null,
  queued: [],

  request: (toolName, prompt) =>
    new Promise<ToolPermissionDecision>((resolve) => {
      const entry: ToolApprovalRequest = { id: newId(), toolName, prompt }
      resolvers.set(entry.id, resolve)
      // 已有卡片在等 → 排到队尾。绝不能就地顶掉：顶掉会让前一个 Promise 永不落地。
      if (get().pending) {
        set((state) => ({ queued: [...state.queued, entry] }))
        return
      }
      set({ pending: entry })
    }),

  respond: (decision) => {
    const { pending, queued } = get()
    if (!pending) return
    const [next, ...rest] = queued
    set({ pending: next ?? null, queued: rest })
    settle(pending.id, decision)
  },

  cancelAll: () => {
    const { pending, queued } = get()
    set({ pending: null, queued: [] })
    if (pending) settle(pending.id, 'deny')
    for (const entry of queued) settle(entry.id, 'deny')
  },
}))
