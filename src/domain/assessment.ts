import { z } from 'zod'

/** 完整评估才能落库，避免摘要已更新、掌握度仍缺失的半成品状态。 */
export const learningAssessmentSchema = z.object({
  summary: z.string().trim().min(1).max(60).describe('学习摘要：概括学习者的实际掌握情况，最多 60 字'),
  mastery: z.number().int().min(0).max(100).describe('依据学习者实际表现给出的掌握度，0-100 的整数'),
  weakPoints: z.array(z.string().trim().min(1).max(24)).max(3)
    .describe('最多 3 条具体薄弱点，每条最多 24 字；没有则给空数组'),
})

export const assessmentUpdateSchema = learningAssessmentSchema.extend({
  reviewEnrollment: z.enum(['enabled', 'disabled']).optional()
    .describe('enabled 加入复习计划，disabled 移出；省略则保留当前计划状态。只有用户要求改变计划时才传入'),
})

export type LearningAssessment = z.infer<typeof learningAssessmentSchema>
export type AssessmentUpdate = z.infer<typeof assessmentUpdateSchema>
