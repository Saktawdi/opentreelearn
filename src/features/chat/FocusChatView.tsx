import {
  Archive,
  // Brain 与 RefreshCw 是本节点掌握度标记用到的两个状态图标（评估中 / 已评估）
  Brain,
  ChevronRight,
  GitBranch,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Trash2,
  Waypoints,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
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
import { isMasteryStale } from '@/domain/mastery/aggregate'
import { messagePreview } from '@/domain/messages'
import type { Id } from '@/domain/models'
import { GRADE_BAND_LABEL, gradeOfScore } from '@/domain/review/schedule'
import { resolveThread, staleSelectionSlots } from '@/domain/thread/resolve'
import { ancestorsOf, buildTreeIndex } from '@/domain/tree/tree'
import { cn } from '@/lib/utils'
import { hasModel } from '@/services/llm/catalog'
import { useSettingsStore } from '@/stores/settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ReviewCenterPanel } from '@/features/review/ReviewCenterPanel'
import { ReviewNudge } from '@/features/review/ReviewNudge'
import { ReviewSessionBar } from '@/features/review/ReviewSessionBar'
import { Composer, type ComposerHandle } from './Composer'
import { MessageList } from './MessageList'
import { SelectionMenu } from './SelectionMenu'

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
  const isSummarizing = useWorkspaceStore((state) =>
    state.summarizingNodeIds.includes(nodeId),
  )
  const updateProjectSettings = useWorkspaceStore((state) => state.updateProjectSettings)
  const selectNode = useWorkspaceStore((state) => state.selectNode)

  const providers = useSettingsStore((state) => state.settings.providers)
  const defaultChatModelRef = useSettingsStore((state) => state.settings.defaultChatModelRef)
  const summaryModelRef = useSettingsStore((state) => state.settings.summaryModelRef)

  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const composerRef = useRef<ComposerHandle>(null)

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
    // 按 fork 时冻结的版本选择解析源节点：源节点之后切版本不改写这个子节点的继承内容
    const visible = sourceNode
      ? resolveThread(sourceNode, messagesByNode[node.forkFrom.nodeId] ?? [], node.forkFrom.selection)
          .path
      : []
    const sourceMessage = visible.find((message) => message.id === node.forkFrom?.messageId)
    const title = sourceNode?.title ?? '已删除的节点'
    const preview = sourceMessage ? messagePreview(sourceMessage, 96) : null
    const stale = sourceNode ? staleSelectionSlots(sourceNode, node.forkFrom.selection).length > 0 : false
    // 找不到 fork 点与被淘汰的固定版本都要在提示条上说清楚：继承内容与源节点当前显示的不一样
    const note = !sourceMessage
      ? '原分支点已不在当前版本中，按整条对话继承'
      : stale
        ? '分支时固定的旧版本已被淘汰，按最新版本继承'
        : null
    // 源消息文本常常就是源节点标题，此时再展示一次只会读成重复
    return { title, preview: preview && preview !== title ? preview : null, note }
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
      {/* 顶部主导航栏（无边框、透明背景） */}
      <header className="flex h-13 shrink-0 items-center justify-between border-b border-line/60 px-5">
        {/* 左侧：面包屑上下文导航 */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden py-1">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-muted">
            {breadcrumbs.slice(0, -1).map((ancestor) => (
              <div key={ancestor.id} className="flex shrink-0 items-center gap-1">
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
              className="min-w-[140px] max-w-[320px] rounded-md border border-accent/50 bg-elevated px-2 py-0.5 text-base font-medium text-ink outline-none"
            />
          ) : (
            <button
              type="button"
              onDoubleClick={() => {
                setDraftTitle(node.title)
                setRenaming(true)
              }}
              title="双击重命名"
              className="max-w-[320px] truncate text-left text-base font-medium text-ink transition-colors hover:text-accent sm:max-w-[420px]"
            >
              {node.title}
            </button>
          )}

          {/* 掌握度：有分数就显示（过期时弱化），没有分数就给一条轻提示引导生成。
              复习中心是元数据节点，没有可评估的学习内容，不显示它 */}
          {node.kind !== 'review' ? (
            <MasteryIndicator
              nodeId={node.id}
              hasSummaryModel={hasSummaryModel}
              summarizing={isSummarizing}
            />
          ) : null}
        </div>

        {/* 右侧：操作区与画布入口 */}
        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted hover:text-ink">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[212px]">
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
                disabled={!hasSummaryModel || isSummarizing}
                onSelect={() => void refreshSummary(node.id)}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isSummarizing && 'animate-spin')} />
                {isSummarizing ? '正在生成摘要…' : '生成学习摘要'}
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

          <span className="mx-0.5 h-4 w-px bg-line/40" />

          {/* 切换/展开折叠右侧知识树地图 */}
          <Tooltip label={isMapCollapsed ? '展开地图 (Ctrl+M)' : '收起地图 (Ctrl+M)'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={isMapCollapsed ? '展开地图' : '收起地图'}
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
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line/60 px-5 py-1.5 text-xs text-muted">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-accent/70" />
          <span className="shrink-0">继承自 {forkInfo.title}</span>
          {forkInfo.preview ? (
            <span className="truncate text-faint">“{forkInfo.preview}”</span>
          ) : null}
          {forkInfo.note ? (
            <span className="shrink-0 text-faint">（{forkInfo.note}）</span>
          ) : null}
        </div>
      ) : null}

      {/* 沉浸对话主舞台（完全铺满容器宽度） */}
      <div className="flex h-full min-h-0 w-full flex-1 flex-col">
        {node.kind === 'review' ? <ReviewCenterPanel /> : null}
        <MessageList nodeId={node.id} />

        {hasChatModel ? (
          <>
            {/* 复习会话进行中、且当前正好轮到这个节点时，贴一条评分浮条 */}
            <ReviewSessionBar nodeId={node.id} />
            {/* 刚学完 + 有到期旧节点 ⇒ 顺手复习一下 */}
            {node.kind !== 'review' ? <ReviewNudge nodeId={node.id} /> : null}
            <Composer
              key={node.id}
              ref={composerRef}
              nodeId={node.id}
              projectId={projectId}
              chatModelRef={chatModelRef}
              onChatModelChange={(ref) => void updateProjectSettings({ chatModelRef: ref ?? undefined })}
            />
            {/* 框选消息正文后的悬浮菜单；引用动作直接落到上面这个输入框 */}
            <SelectionMenu
              key={`selection-${node.id}`}
              nodeId={node.id}
              onQuote={(text) => composerRef.current?.appendQuote(text)}
            />
          </>
        ) : (
          <div className="shrink-0 border-t border-line/60 px-5 py-4 text-sm text-muted">
            未配置对话模型，先到{' '}
            <Link to="/settings" className="text-accent underline underline-offset-4">
              配置
            </Link>{' '}
            页添加。
          </div>
        )}
      </div>

      {/* 删除确认对话框 */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="w-[min(400px,100%)]">
          <DialogHeader>
            <DialogTitle>删除节点</DialogTitle>
            <DialogDescription>
              会连同「{node.title}」的全部子节点与对话一起删除，无法恢复。
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
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * 节点头部的掌握度标记。
 *
 * 三种形态：有分数（过期时弱化 + 说明）、没有分数（轻提示引导生成，**不自动调用 LLM**）、
 * 生成中（转圈）。没有分数时不弹窗、不打扰，只是一条可点的提示。
 */
function MasteryIndicator({
  nodeId,
  hasSummaryModel,
  summarizing,
}: {
  nodeId: Id
  hasSummaryModel: boolean
  summarizing: boolean
}) {
  const mastery = useWorkspaceStore(
    (state) => state.nodes.find((item) => item.id === nodeId)?.mastery,
  )
  const lastStudiedAt = useWorkspaceStore(
    (state) => state.nodes.find((item) => item.id === nodeId)?.lastStudiedAt,
  )
  const refreshSummary = useWorkspaceStore((state) => state.refreshSummary)

  if (summarizing) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted">
        <RefreshCw className="h-3 w-3 animate-spin" />
        评估中
      </span>
    )
  }

  if (!mastery) {
    if (!hasSummaryModel) return null
    return (
      <Tooltip label="根据这段对话评估掌握度，并给出薄弱点">
        <button
          type="button"
          onClick={() => void refreshSummary(nodeId)}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent/50 hover:text-accent"
        >
          <Brain className="h-3 w-3" />
          还没有掌握度 · 生成评估
        </button>
      </Tooltip>
    )
  }

  const stale = isMasteryStale(mastery, lastStudiedAt)
  const band = GRADE_BAND_LABEL[gradeOfScore(mastery.score)]

  return (
    <Tooltip
      label={
        stale
          ? '生成评估后又继续学习过，分数可能已过期 —— 重新生成一次评估'
          : mastery.weakPoints?.length
            ? `薄弱：${mastery.weakPoints.join('、')}`
            : `掌握档位：${band}`
      }
    >
      <button
        type="button"
        onClick={() => hasSummaryModel && void refreshSummary(nodeId)}
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors',
          stale
            ? 'border-line text-faint hover:border-accent/40 hover:text-accent'
            : 'border-accent/35 bg-accent-soft text-accent',
        )}
      >
        <Brain className="h-3 w-3" />
        <span className="tabular-nums">掌握 {mastery.score}</span>
        <span className="text-faint">· {band}</span>
        {stale ? <span className="text-faint">· 已过期</span> : null}
      </button>
    </Tooltip>
  )
}
