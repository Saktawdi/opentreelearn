import type { Id } from '@/domain/models'

/**
 * Agent 调用高敏感工具（如更新学习评估）时，在执行层拦截的授权请求。
 */
export interface ToolPermissionRequest {
  id: string
  toolName: string
  nodeId: Id
  nodeTitle: string
  reason?: string
}

/**
 * 用户的授权决策：
 * - `allow_once`: 仅批准当前这次调用；
 * - `allow_always`: 批准本次，且后续同类操作默认自动批准（不再弹卡片询问）；
 * - `deny`: 拒绝本次执行。
 */
export type ToolPermissionDecision = 'allow_once' | 'allow_always' | 'deny'
