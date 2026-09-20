import {
  Archive,
  ChevronRight,
  GitBranch,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  Trash2,
  Waypoints,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { messagePreview } from '@/domain/messages'
import type { Id } from '@/domain/models'
import { ancestorsOf, buildTreeIndex } from '@/domain/tree/tree'
import { hasModel } from '@/services/llm/catalog'
import { useSettingsStore } from '@/stores/settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ModelPicker } from '@/features/settings/ModelPicker'
import { cn } from '@/lib/utils'
import { Composer } from './Composer'
import { MessageList } from './MessageList'

export function FocusChatView({
  nodeId,
  isMapCollapsed = false,
  onToggleMap,
}: {
  nodeId: Id
  isMapCollapsed?: boolean
  onToggleMap: () => void
}) {
  const node = useWorkspaceStore((state) => state.nodes.find((item) => item.id === nodeId))
  const nodes = useWorkspaceStore((state) => state.nodes)
  const messagesByNode = useWorkspaceStore((state) => state.messagesByNode)
  const projectId = useWorkspaceStore((state) => state.projectId)
  const projectSettings = useWorkspaceStore((state) => state.projectSettings)
  const setNodeTitle = useWorkspaceStore((state) => state.setNodeTitle)
  const applyAction = useWorkspaceStore((state) => state.applyAction)
  const archiveNode = useWorkspaceStore((state) => state.archiveNode)
  const deleteNode = useWorkspaceStore((state) => state.deleteNode)
  const refreshSummary = useWorkspaceStore((state) => state.refreshSummary)
  const updateProjectSettings = useWorkspaceStore((state) => state.updateProjectSettings)
  const selectNode = useWorkspaceStore((state) => state.selectNode)

  const providers = useSettingsStore((state) => state.settings.providers)
  const defaultChatModelRef = useSettingsStore((state) => state.settings.defaultChatModelRef)
  const summaryModelRef = useSettingsStore((state) => state.settings.summaryModelRef)

  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 祖先路径链路（面包屑）
  const breadcrumbs = useMemo(() => {
    if (!node) return []
    const index = buildTreeIndex(nodes)
    const ancestors = ancestorsOf(index, node.id)
    return [...ancestors, node]
  }, [node, nodes])

  const forkInfo = useMemo(() => {
    if (!node?.forkFrom) return null
    const sourceNode = nodes.find((item) => item.id === node.forkFrom?.nodeId)
    const sourceMessage = (messagesByNode[node.forkFrom.nodeId] ?? []).find(
      (message) => message.id === node.forkFrom?.messageId,
    )
    return {
      title: sourceNode?.title ?? '已删除的节点',
      preview: sourceMessage ? messagePreview(sourceMessage, 96) : null,
    }
  }, [node, nodes, messagesByNode])

  if (!node || !projectId) return null

  const chatModelRef = projectSettings?.chatModelRef ?? defaultChatModelRef
  const hasChatModel = hasModel(providers, chatModelRef)
  const hasSummaryModel = hasModel(providers, summaryModelRef)

  const commitRename = async () => {
    setRenaming(false)
    const next = draftTitle.trim()
    if (next && next !== node.title) await setNodeTitle(node.id, next)
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-canvas">
      {/* 顶部主导航栏 */}
      <header className="flex h-13 shrink-0 items-center justify-between border-b border-line/60 bg-surface/50 px-4 backdrop-blur sm:px-6">
        {/* 左侧：面包屑上下文导航 */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden py-1">
          <div className="flex items-center gap-1 text-[12.5px] text-muted">
            {breadcrumbs.slice(0, -1).map((ancestor) => (
              <div key={ancestor.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => selectNode(ancestor.id)}
                  className="max-w-[140px] truncate transition-colors hover:text-ink"
                  title={ancestor.title}
                >
                  {ancestor.title}
                </button>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-40" />
              </div>
            ))}
          </div>

          {renaming ? (
            <input
              value={draftTitle}
              autoFocus
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void commitRename()
                if (event.key === 'Escape') setRenaming(false)
              }}
              className="min-w-[140px] max-w-[320px] rounded-md border border-accent/50 bg-elevated px-2 py-0.5 text-[14px] font-semibold text-ink outline-none"
            />
          ) : (
            <button
              type="button"
              onDoubleClick={() => {
                setDraftTitle(node.title)
                setRenaming(true)
              }}
              title="双击重命名"
              className="max-w-[320px] truncate text-left text-[14px] font-semibold text-ink transition-colors hover:text-accent sm:max-w-[420px]"
            >
              {node.title}
            </button>
          )}
        </div>

        {/* 右侧：操作区、模型选择与画布入口 */}
        <div className="flex shrink-0 items-center gap-2">
          <ModelPicker
            value={chatModelRef}
            onChange={(ref) => void updateProjectSettings({ chatModelRef: ref ?? undefined })}
          />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[228px]">
              <DropdownMenuLabel>节点分支与整理</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void applyAction('child', node.id)}>
                <GitBranch className="h-3.5 w-3.5" />
                新建空白子节点
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void applyAction('branch', node.id)}>
                <GitBranch className="h-3.5 w-3.5" />
                从最新消息分支
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void applyAction('diverge', node.id)}>
                <Waypoints className="h-3.5 w-3.5" />
                从最新消息横向发散
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!hasSummaryModel}
                onSelect={() => void refreshSummary(node.id)}
              >
                <Sparkles className="h-3.5 w-3.5" />
                重新生成摘要
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void archiveNode(node.id)}>
                <Archive className="h-3.5 w-3.5" />
                归档（含子树）
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-danger focus:text-danger"
                onSelect={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除（含子树）
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="mx-0.5 h-4 w-px bg-line" />

          {/* 切换/展开折叠右侧知识树地图 */}
          <Tooltip label={isMapCollapsed ? '展开知识树地图 (Ctrl+M)' : '收起知识树地图 (Ctrl+M)'}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleMap}
              className="text-muted hover:text-ink"
            >
              {isMapCollapsed ? (
                <PanelRightOpen className="h-4 w-4 text-accent" />
              ) : (
                <PanelRightClose className="h-4 w-4" />
              )}
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* 继承提示条 */}
      {forkInfo ? (
        <div className="flex shrink-0 items-center justify-center border-b border-line/60 bg-accent-soft/20 px-4 py-1.5 text-center">
          <div className="flex items-center gap-1.5 text-[12px] text-accent/90">
            <GitBranch className="h-3.5 w-3.5" />
            <span>继承自《{forkInfo.title}》</span>
            {forkInfo.preview ? <span className="text-muted">“{forkInfo.preview}”</span> : null}
          </div>
        </div>
      ) : null}

      {/* 沉浸对话主舞台（完全铺满容器宽度） */}
      <div className="flex h-full min-h-0 w-full flex-1 flex-col">
        <MessageList nodeId={node.id} />

        {hasChatModel ? (
          <Composer key={node.id} nodeId={node.id} projectId={projectId} />
        ) : (
          <div className={cn('shrink-0 border-t border-line/60 p-6 text-center')}>
            <p className="text-[13px] leading-relaxed text-muted">
              还没有可用的对话模型。请先到{' '}
              <Link to="/settings" className="text-accent underline underline-offset-4">
                配置
              </Link>{' '}
              页填写 BYOK 提供商与模型密钥，或在上方切换模型。
            </p>
          </div>
        )}
      </div>

      {/* 删除确认对话框 */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="w-[min(420px,100%)]">
          <DialogHeader>
            <DialogTitle>删除节点</DialogTitle>
            <DialogDescription>
              将删除「{node.title}」及其全部子节点与对话记录，无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false)
                void deleteNode(node.id)
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
