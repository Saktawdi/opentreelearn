import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { asData, failure, fitsData } from './result'

/** 所有带工具的入口共用；清单来自最终注册集，避免漏掉写工具或复习交付工具。 */
export const TOOL_WORKFLOW_SYSTEM = [
  '## 工具发现与执行流程',
  '- list_tools 列出当前会话实际可调用的全部工具。用户问有哪些工具，或你不确定能力时调用；已知道该用哪个工具时直接调用，无需每轮先列清单。',
  '- 在本轮任何阶段都可以调用工具，包括已经输出讲解之后、收到工具结果之后，以及后续对话轮次；工具不限于开头使用。',
  '- 每次收到结果后判断信息是否足够；若出现新的信息缺口，继续检索或调用其他适用工具，可交替进行简短讲解和工具调用。需要前一步结果的调用应等结果返回后再发起。',
  '- 需要执行操作时实际调用工具，只有成功结果才能作为已完成的依据；列出工具不等于获得执行授权，仍须遵守各工具的权限与作用域。',
  '- 信息充分且任务完成后给出最终回答；需要学习者回答或澄清时结束本轮等待，不要无目的重复调用。纯文本结束后不会自动进入下一步，尚需工具时应在结束本轮前发起调用。',
].join('\n')

export function withToolDiscovery(tools: ToolSet): ToolSet {
  const available: ToolSet = { ...tools }
  const descriptionOf = (entry: ToolSet[string]): string =>
    typeof entry.description === 'string' ? entry.description : '用途与参数见当前工具定义'
  available.list_tools = tool({
    description: '列出当前会话实际可用的全部工具名称与用途简介（包括 list_tools 本身）；提供 name 可查看某个工具的完整用途说明。参数格式以工具定义为准。此工具只读取能力清单，不修改项目数据。',
    inputSchema: z.object({
      name: z.string().optional().describe('可选：查看某个已注册工具的完整说明；省略则列出全部工具'),
    }),
    execute: async ({ name }) => {
      if (name !== undefined) {
        const entry = Object.hasOwn(available, name) ? available[name] : undefined
        return entry
          ? asData({ name, description: descriptionOf(entry) })
          : failure('当前会话没有这个工具，请用 list_tools 查看可用工具')
      }
      // 优先保留全部名称，缩短简介而不是让通用结果裁剪丢掉工具条目。
      for (const length of [80, 40, 0]) {
        const entries = Object.entries(available).map(([name, entry]) => ({
          name,
          ...(length > 0 ? {
            description: descriptionOf(entry).length > length
              ? `${descriptionOf(entry).slice(0, length)}…`
              : descriptionOf(entry),
          } : {}),
        }))
        const payload = { total: entries.length, tools: entries }
        if (fitsData(payload)) return asData(payload)
      }
      return failure('工具清单超过结果预算，无法完整列出；请提供 name 查询具体工具')
    },
  })
  return available
}
