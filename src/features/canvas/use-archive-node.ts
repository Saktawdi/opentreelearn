import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { Id } from '@/domain/models'
import { useWorkspaceStore } from '@/stores/workspace-store'

/**
 * 归档 + 就地可撤销的 toast。
 *
 * 归档本身是静默动作（节点连同子树从画布与复习队列里消失），没有确认对话框，
 * 后悔药必须当场给足：toast 里直接放「撤销」，按 archiveNode 返回的名单原样恢复。
 * 与 Agent 改动的撤销条是同一个心智模型——后悔药，不是操作历史。
 */
export function useArchiveNodeWithUndo() {
  const { t } = useTranslation('canvas')
  const archiveNode = useWorkspaceStore((state) => state.archiveNode)
  const restoreArchivedNodes = useWorkspaceStore((state) => state.restoreArchivedNodes)

  return async (nodeId: Id) => {
    const previous = await archiveNode(nodeId)
    if (!previous || previous.length === 0) return
    toast.success(t('archive.archivedNodes', { count: previous.length }), {
      description: t('archive.description'),
      duration: 10000,
      action: {
        label: t('archive.undo'),
        onClick: () => void restoreArchivedNodes(previous),
      },
    })
  }
}
