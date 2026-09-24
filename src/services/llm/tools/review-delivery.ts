import { tool } from 'ai'
import { z } from 'zod'
import type { Id, ReviewGrade } from '@/domain/models'
import type { ToolSet } from 'ai'
import { asData, failure } from './registry'

/**
 * 复习会话的**交付工具**（agent 升级阶段 1）。
 *
 * 可执行产物（补学 / 题目 / 提示 / 反馈）只能通过这里的工具落库 —— 契约从
 * 跨轮提示词文案搬进 schema 与守卫：`[[rating:...]]` 标记协议退役，档位由
 * `submit_feedback` 的枚举参数交付；守卫（未回答题、回答存在性）在 store 的
 * handler 里对着**活会话**校验（权威），工具层只做形状与包装。
 *
 * 阶段 1 是**单工具绑定**：一次请求只暴露本轮用途对应的那一个工具，行为确定
 * 性最高；阶段 3 合并轮次时才暴露全集。所有 handler 调用即落库（交付即持久化，
 * 中断时已交付的卡片保留）。
 */

export interface ReviewDeliveryResult {
  ok: boolean
  error?: string
}

/** 由 store 实现：校验 + 原子落库（消息 + 阶段 + 副作用）。工具不碰存储。 */
export interface ReviewDeliveryHandlers {
  deliverTeach(input: { keyPoints: string[]; explanation: string }): Promise<ReviewDeliveryResult>
  deliverQuestion(input: { question: string; rephraseOf?: Id }): Promise<ReviewDeliveryResult>
  deliverHint(input: { hint: string }): Promise<ReviewDeliveryResult>
  deliverFeedback(input: {
    strengths: string
    gaps: string
    suggestedGrade: ReviewGrade
  }): Promise<ReviewDeliveryResult>
}

export type ReviewDeliveryKind = 'teach_key_points' | 'pose_question' | 'give_hint' | 'submit_feedback'

/** 各交付工具名 → 建议档位枚举共用。 */
const GRADE_SCHEMA = z
  .enum(['again', 'hard', 'good', 'easy'])
  .describe(
    '本次判定的建议档位：again 没想起来 / hard 有点吃力 / good 基本掌握 / easy 很熟悉。最终以用户确认为准。',
  )

/**
 * 构建本轮的交付工具集。
 *
 * @param kind          本轮允许的交付工具（阶段 1 每轮一个）
 * @param handlers      store 注入的落库回调
 * @param rephraseOf    换问法轮由 store 预绑当前开放题 id —— 消息 id 不进模型
 *                      上下文，模型无从填写；绑死后 schema 里也不再出现该参数
 */
export function buildReviewDeliveryTool(
  kind: ReviewDeliveryKind,
  handlers: ReviewDeliveryHandlers,
  options: { rephraseOf?: Id } = {},
): ToolSet {
  switch (kind) {
    case 'teach_key_points':
      return {
        teach_key_points: tool({
          description:
            '交付补学关键点：用最短的篇幅讲清最关键的概念/推导（只补缺口，不要从头讲一遍）。交付即展示给学习者，交付后简短收尾即可，不要在正文里重复内容。',
          inputSchema: z.object({
            keyPoints: z
              .array(z.string().min(1).max(80))
              .min(1)
              .max(6)
              .describe('本主题的关键点，3~5 条最合适；每条一句话'),
            explanation: z
              .string()
              .min(1)
              .describe(
                '围绕关键点的讲解（markdown，公式用 LaTeX）。不要在结尾让学习者复述、出思考题或留练习 —— 学习者在界面点「试着复述」后会单独收到一道题，正文里再出现问题会变成两道题打架。',
              ),
          }),
          execute: async (input) => {
            const result = await handlers.deliverTeach(input)
            return result.ok ? asData({ ok: true }) : failure(result.error ?? '交付失败')
          },
        }),
      }

    case 'pose_question':
      return {
        pose_question: tool({
          description: options.rephraseOf
            ? '交付当前题的**换问法**：考查的知识点必须完全相同，不要偷偷加新题、也不要换成别的知识点；只输出新问法本身。'
            : '交付**一道**需要主动回忆的题：优先出结构性题目；题干以「用自己的话解释：…」这类问句结束；一道题可以包含多个小问；不要给出答案、不要提示思路。交付即展示给学习者。',
          inputSchema: z.object({
            question: z.string().min(1).describe('完整题干（markdown，公式用 LaTeX）'),
            ...(options.rephraseOf
              ? {}
              : {
                  rephraseOf: z
                    .string()
                    .optional()
                    .describe('要换问法的那道题的消息 id；新出题时不要填'),
                }),
          }),
          execute: async (input) => {
            const result = await handlers.deliverQuestion({
              question: input.question,
              // 条件化 schema 让 TS 拿不到精确形状；换问法轮由 options 预绑，参数不来自模型
              rephraseOf: options.rephraseOf ?? (input.rephraseOf as Id | undefined),
            })
            return result.ok ? asData({ ok: true }) : failure(result.error ?? '交付失败')
          },
        }),
      }

    case 'give_hint':
      return {
        give_hint: tool({
          description:
            '交付针对**当前未回答题目**的一点提示：只给方向（该回忆哪一部分、从哪个条件入手），不要写出完整答案，不要代答，不要转向材料里的其他内容另起一问。',
          inputSchema: z.object({
            hint: z.string().min(1).describe('提示内容（markdown）'),
          }),
          execute: async (input) => {
            const result = await handlers.deliverHint(input)
            return result.ok ? asData({ ok: true }) : failure(result.error ?? '交付失败')
          },
        }),
      }

    case 'submit_feedback':
      return {
        submit_feedback: tool({
          description:
            '交付对学习者最新回答的点评与判定建议。最终档位由用户确认，你给的是建议；点评要点名依据（学习者原文的关键处），不要复述学习者的整段回答。',
          inputSchema: z.object({
            strengths: z.string().describe('先指出做对的地方；没有就如实说本轮没有'),
            gaps: z.string().describe('待补充/需要修正的地方；答错了就直接说清楚正确思路'),
            suggestedGrade: GRADE_SCHEMA,
          }),
          execute: async (input) => {
            const result = await handlers.deliverFeedback(input)
            return result.ok ? asData({ ok: true }) : failure(result.error ?? '交付失败')
          },
        }),
      }
  }
}
