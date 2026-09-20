import { Archive, GitBranch, MoreHorizontal, Sparkles, Trash2, Waypoints, X } from 'lucide-react'
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
import { hasModel } from '@/services/llm/catalog'
import { useSettingsStore } from '@/stores/settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ModelPicker } from '@/features/settings/ModelPicker'
import { cn } from '@/lib/utils'
import { Composer } from './Composer'
import { MessageList } from './MessageList'

export function ChatPanel({ nodeId, onClose }: { nodeId: Id; onClose: () => void }) {
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

  const providers = useSettingsStore((state) => state.settings.providers)
  const defaultChatModelRef = useSettingsStore((state) => state.settings.defaultChatModelRef)
  const summaryModelRef = useSettingsStore((state) => state.settings.summaryModelRef)

  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

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
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-13 shrink-0 items-center gap-1.5 border-b border-line px-3">
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
            className="min-w-0 flex-1 rounded-md border border-accent/50 bg-canvas px-2 py-1 text-[13.5px] font-medium text-ink outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => {
              setDraftTitle(node.title)
              setRenaming(true)
            }}
            title="双击重命名"
            className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium text-ink transition-colors hover:text-accent"
          >
            {node.title}
          </button>
        )}

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
            <DropdownMenuLabel>节点</DropdownMenuLabel>
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

        <Tooltip label="关闭面板">
          <Button variant="ghost" size="icon-sm" className="text-muted" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </Tooltip>
      </header>

      {forkInfo ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-line/70 bg-accent-soft/25 px-3 py-2">
          <GitBranch className="mt-[3px] h-3.5 w-3.5 shrink-0 text-accent/80" />
          <div className="min-w-0 text-[11.5px] leading-relaxed">
            <span className="text-accent/90">继承自《{forkInfo.title}》</span>
            {forkInfo.preview ? (
              <span className="ml-1 text-muted">“{forkInfo.preview}”</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <MessageList nodeId={node.id} />

      {hasChatModel ? (
        <Composer key={node.id} nodeId={node.id} projectId={projectId} />
      ) : (
        <div className={cn('shrink-0 border-t border-line p-4')}>
          <p className="text-[12.5px] leading-relaxed text-muted">
            还没有可用的对话模型。请先到{' '}
            <Link to="/settings" className="text-accent underline underline-offset-4">
              配置
            </Link>{' '}
            页填写 BYOK 提供商与模型密钥，或在上方切换模型。
          </p>
        </div>
      )}

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