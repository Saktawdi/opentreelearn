import { tool } from 'ai'
import { z } from 'zod'
import { MERMAID_SOURCE_LIMIT, validateMermaid } from '@/lib/mermaid'
import { asData, failure } from './result'

export const DIAGRAM_TOOL_NAME = 'create_diagram'

export const diagramInputSchema = z.object({
  title: z.string().trim().min(1).max(120).describe('图表标题，使用学习者的语言'),
  source: z.string().min(1).max(MERMAID_SOURCE_LIMIT).describe('完整 Mermaid 源码，不含 Markdown 围栏、YAML frontmatter 或 init 配置。思维导图用 mindmap；DAG/AOV/AOE/带权图用 flowchart，AOE 活动和耗时放在边标签上。数学公式使用 $$...$$ 包裹 LaTeX（不是单个 $），保留反斜杠；例如节点标签「代数方程 $$Ax = \\lambda x$$」。含公式或特殊符号的节点标签用双引号包裹，例如 flowchart 的 A["$$Ax = \\lambda x$$"]、mindmap 的 n["方程 $$Ax = \\lambda x$$"]。不要把 \\lambda 等公式命令退化成 lambda 等普通文字。'),
})

export function buildDiagramTools() {
  return {
    create_diagram: tool({
      description: '生成并展示 Mermaid 图表：思维导图、DAG、AOV/AOE、带权有向/无向图、流程图、时序图、状态图、类图、ER 图等。需要图示时优先使用此工具，不画 ASCII 图。成功后图表自动加入当前回答并保存，无需在正文重复源码；失败时按错误修正后重试。只校验 Mermaid 语法，不验证无环性或计算关键路径等算法结果。',
      inputSchema: diagramInputSchema,
      execute: async (input) => {
        try {
          const parsed = diagramInputSchema.parse(input)
          const { diagramType } = await validateMermaid(parsed.source)
          return asData({ ok: true, title: parsed.title, diagramType })
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
      },
    }),
  }
}
