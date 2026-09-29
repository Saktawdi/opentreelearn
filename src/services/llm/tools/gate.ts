import { deniedResult, resolveToolApproval, type GateContext } from '@/domain/agent/permissions'
import { useToolApprovalStore } from '@/stores/tool-approval-store'
import { failure } from './result'
/**
 * 工具授权闸门：在 `execute` 外面包一层，先问再干活。
 *
 * 为什么包在 execute 而不是用 AI SDK 的 `needsApproval`：
 * 那套要重建流、把批准结果作为新的一次调用发回去，三条链路（对话 / 自由答 /
 * 复习）各要改一遍状态机。而我们需要的只是「停在这里，用户点了再走」——
 * execute 里 await 一个 Promise 天然就是这个语义，且不打断已经流出去的正文。
 *
 * 判定规则全在 `domain/agent/permissions`，这里只负责执行：放行就跑，拒绝就
 * 回一条结构化说明让模型自己转告用户。
 */

/** AI SDK 工具的最小形状：闸门只碰 execute，其余原样透传。 */
interface GatedTool {
  execute?: (input: never, options: never) => unknown
}

type ToolMap = Record<string, GatedTool>

export function withToolApproval<T extends ToolMap>(tools: T, ctx: GateContext): T {
  const gated: ToolMap = {}

  for (const [name, tool] of Object.entries(tools)) {
    const original = tool.execute
    if (typeof original !== 'function') {
      gated[name] = tool
      continue
    }
    gated[name] = {
      ...tool,
      execute: (async (input: never, options: never) => {
        const verdict = resolveToolApproval(name, input, ctx)
        if (verdict.action === 'allow') return original(input, options)

        const decision = await useToolApprovalStore.getState().request(name, verdict.prompt)
        if (decision === 'deny') return failure(deniedResult(name))
        return original(input, options)
      }) as GatedTool['execute'],
    }
  }

  return gated as T
}
