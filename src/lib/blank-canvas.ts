import type { Id } from '@/domain/models'

/** 空白项目落地画布的判断依据（见 isBlankCanvasOpen）。 */
export interface BlankCanvasInput {
  /** 项目数据是否仍在载入 */
  loading: boolean
  /** 路由上的项目 id */
  projectId: Id | null | undefined
  /** 工作区当前已载入的项目 id */
  workspaceProjectId: Id | null
  /** 当前项目的可见节点是否为空 */
  isEmpty: boolean
  /** 用户手动收起过画布的项目 id；null 表示没有 */
  dismissedFor: Id | null
}

/**
 * 空白项目（一个节点都没有）是否该用展开画布占场。
 *
 * 空项目没有对话可看，分栏布局里左边只剩一句「未选中节点」，不如把整块画布给出来，
 * 「第一个问题」的入口就摆在画布正中间。三条边界条件都在这里说清楚：
 *
 * 1. 数据没到位时 `nodes` 本来就是空的，不能把「正在载入」当成空项目；
 * 2. 只认**当前**项目的空 —— 上一个项目的数据还挂在 store 上时不算；
 * 3. 用户自己收起过（dismissedFor）就不再用画布占场，否则会像「关不掉」。
 *
 * 判断是纯派生的、不带副作用：第一个节点一出现 isEmpty 即为假，画布随之收起，
 * 回答直接在左边流式呈现。
 */
export function isBlankCanvasOpen(input: BlankCanvasInput): boolean {
  const { loading, projectId, workspaceProjectId, isEmpty, dismissedFor } = input
  if (loading || !projectId) return false
  if (workspaceProjectId !== projectId) return false
  return isEmpty && dismissedFor !== projectId
}
