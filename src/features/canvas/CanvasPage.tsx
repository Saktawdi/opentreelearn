import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import { Loader2, Maximize2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip } from '@/components/ui/tooltip'
import { FocusChatView } from '@/features/chat/FocusChatView'
import { cn } from '@/lib/utils'
import { hasModel } from '@/services/llm/catalog'
import { useSettingsStore } from '@/stores/settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CanvasContextMenu, type CanvasContextMenuTarget } from './CanvasContextMenu'
import { buildGraph } from './graph'
import { LearnNodeCard } from './LearnNodeCard'
import { LearnNodeDot } from './LearnNodeDot'
import { StarterPanel } from './StarterPanel'

const nodeTypes = {
  learn: LearnNodeCard,
  dot: LearnNodeDot,
}

export function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace />
    </ReactFlowProvider>
  )
}

function CanvasWorkspace() {
  const { projectId } = useParams<{ projectId: string }>()
  const { fitView, setViewport, screenToFlowPosition } = useReactFlow()

  const openProject = useWorkspaceStore((state) => state.openProject)
  const reset = useWorkspaceStore((state) => state.reset)
  const project = useWorkspaceStore((state) => state.project)
  const nodes = useWorkspaceStore((state) => state.nodes)
  const messagesByNode = useWorkspaceStore((state) => state.messagesByNode)
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId)
  const loading = useWorkspaceStore((state) => state.loading)
  const error = useWorkspaceStore((state) => state.error)
  const selectNode = useWorkspaceStore((state) => state.selectNode)
  const relayout = useWorkspaceStore((state) => state.relayout)
  const applyAction = useWorkspaceStore((state) => state.applyAction)
  const startRootNode = useWorkspaceStore((state) => state.startRootNode)
  const archiveNode = useWorkspaceStore((state) => state.archiveNode)
  const deleteNode = useWorkspaceStore((state) => state.deleteNode)
  const refreshSummary = useWorkspaceStore((state) => state.refreshSummary)

  const providers = useSettingsStore((state) => state.settings.providers)
  const summaryModelRef = useSettingsStore((state) => state.settings.summaryModelRef)
  const hasSummaryModel = hasModel(providers, summaryModelRef)

  // 布局状态：右侧地图宽度与折叠状态
  const [mapWidth, setMapWidth] = useState<number>(320)
  const [isMapCollapsed, setIsMapCollapsed] = useState<boolean>(false)
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null)

  // 始终在侧边栏使用微缩点模式（Mini Map Dot 节点）
  const isMiniMode = true

  const [contextMenu, setContextMenu] = useState<CanvasContextMenuTarget | null>(null)

  // 全局快捷键 Ctrl/Cmd + M 切换右侧地图展开/收起
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault()
        setIsMapCollapsed((v) => !v)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // 新建根节点对话框状态
  const [createRootDialog, setCreateRootDialog] = useState<{
    open: boolean
    flowPosition: { x: number; y: number } | null
    question: string
  }>({
    open: false,
    flowPosition: null,
    question: '',
  })

  // 删除确认对话框
  const [nodeToDelete, setNodeToDelete] = useState<string | null>(null)

  useEffect(() => {
    if (projectId) void openProject(projectId)
    return () => {
      reset()
    }
  }, [projectId, openProject, reset])

  const graph = useMemo(
    () => buildGraph(nodes, messagesByNode, selectedNodeId, { miniMapMode: isMiniMode }),
    [nodes, messagesByNode, selectedNodeId, isMiniMode],
  )

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(graph.nodes)

  useEffect(() => {
    setFlowNodes(graph.nodes)
  }, [graph, setFlowNodes])

  const activeCount = graph.nodes.length
  const isEmpty = activeCount === 0

  useEffect(() => {
    if (isEmpty) return
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.34, duration: 0.35, maxZoom: 1 })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [projectId, isEmpty, fitView])

  const handleNodeClick = (_: ReactMouseEvent, node: { id: string }) => {
    setContextMenu(null)
    selectNode(node.id)
  }

  const handleNodeContextMenu = (event: ReactMouseEvent, node: { id: string }) => {
    event.preventDefault()
    selectNode(node.id)
    setContextMenu({
      type: 'node',
      nodeId: node.id,
      x: event.clientX,
      y: event.clientY,
    })
  }

  const handlePaneContextMenu = (event: ReactMouseEvent | MouseEvent) => {
    event.preventDefault()
    const flowPosition = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    })
    setContextMenu({
      type: 'pane',
      x: event.clientX,
      y: event.clientY,
      flowPosition,
    })
  }

  const handleCreateRoot = async () => {
    const q = createRootDialog.question.trim()
    if (!q) return
    const pos = createRootDialog.flowPosition
    setCreateRootDialog({ open: false, flowPosition: null, question: '' })
    await startRootNode(q, pos)
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-[13.5px] text-ink">{error}</p>
        <Link to="/" className="text-[13px] text-accent underline underline-offset-4">
          返回项目列表
        </Link>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-canvas">
      {/* 左侧：主对话舞台（FocusChatView） */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedNodeId ? (
          <FocusChatView
            nodeId={selectedNodeId}
            isMapCollapsed={isMapCollapsed}
            onToggleMap={() => setIsMapCollapsed((v) => !v)}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted">
            <p className="text-[14px]">暂无选中节点</p>
            <p className="max-w-sm text-[12.5px] leading-relaxed text-muted/70">
              请在右侧知识树地图中选择或新建一个节点，开启深度对话与知识推演。
            </p>
            {isMapCollapsed ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsMapCollapsed(false)}
                className="mt-2"
              >
                展开知识树地图
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {/* 中间拖拽调节手柄（弱化实线边框，采用无缝自然渐隐过渡，消除割裂感） */}
      {!isMapCollapsed ? (
        <div
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            resizeState.current = { startX: event.clientX, startWidth: mapWidth }
          }}
          onPointerMove={(event) => {
            if (!resizeState.current) return
            // 从右往左拖动增大，从左往右拖动减小
            const delta = resizeState.current.startX - event.clientX
            setMapWidth(
              Math.min(Math.max(resizeState.current.startWidth + delta, 220), 600),
            )
          }}
          onPointerUp={(event) => {
            resizeState.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          className="group relative z-30 flex w-1 cursor-col-resize items-center justify-center bg-transparent transition-colors hover:bg-accent/40"
        >
          <div className="h-10 w-1 rounded-full bg-line-strong/60 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      ) : null}

      {/* 右侧：知识树导航地图（Canvas Map，微缩点树形态，背景同源融合） */}
      <div
        style={{ width: isMapCollapsed ? 0 : mapWidth }}
        className={cn(
          'relative flex h-full flex-col overflow-hidden bg-canvas transition-[width] duration-200 ease-in-out border-l border-line/40',
          isMapCollapsed && 'pointer-events-none opacity-0 border-l-0',
        )}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={graph.edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          onNodeContextMenu={handleNodeContextMenu}
          onPaneContextMenu={handlePaneContextMenu}
          onPaneClick={() => {
            setContextMenu(null)
          }}
          fitView
          fitViewOptions={{ padding: 0.28, maxZoom: 1.4 }}
          minZoom={0.2}
          maxZoom={2.4}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#181c23" />
        </ReactFlow>

        {/* 顶部极简信息标与操作 */}
        <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5">
          <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-line/60 bg-surface/80 px-2 py-1 shadow-sm backdrop-blur">
            <span className="text-[11px] text-muted">导航</span>
            <Badge tone="neutral" className="text-[10px] px-1 py-0">
              {activeCount}
            </Badge>
            <Tooltip label="重新居中视图">
              <button
                type="button"
                onClick={() => void fitView({ padding: 0.28, duration: 0.4, maxZoom: 1.4 })}
                className="ml-0.5 rounded p-0.5 text-muted hover:text-ink"
              >
                <Maximize2 className="h-3 w-3" />
              </button>
            </Tooltip>
          </div>
        </div>

        {loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        ) : null}

        {isEmpty && !loading ? (
          <StarterPanel
            projectName={project?.name ?? '新项目'}
            onSubmit={(question) => startRootNode(question)}
          />
        ) : null}

        <CanvasContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          hasSummaryModel={hasSummaryModel}
          onNodeAction={(kind, nodeId) => {
            selectNode(nodeId)
            void applyAction(kind, nodeId)
          }}
          onRefreshSummary={(nodeId) => void refreshSummary(nodeId)}
          onArchiveNode={(nodeId) => void archiveNode(nodeId)}
          onDeleteNode={(nodeId) => setNodeToDelete(nodeId)}
          onCreateRootAt={(flowPosition) =>
            setCreateRootDialog({ open: true, flowPosition, question: '' })
          }
          onRelayout={() => void relayout()}
          onFitView={() => void fitView({ padding: 0.34, duration: 0.5, maxZoom: 1 })}
          onResetView={() => void setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 400 })}
        />

        {/* 在此处新建根节点对话框 */}
        <Dialog
          open={createRootDialog.open}
          onOpenChange={(open) => {
            if (!open) setCreateRootDialog({ open: false, flowPosition: null, question: '' })
          }}
        >
          <DialogContent className="w-[min(520px,100%)]">
            <DialogHeader>
              <DialogTitle>新建根学习节点</DialogTitle>
              <DialogDescription>
                在画布指定位置开辟全新的知识主题，开始第一个问题。
              </DialogDescription>
            </DialogHeader>
            <div className="py-2">
              <Textarea
                value={createRootDialog.question}
                autoFocus
                rows={4}
                onChange={(e) =>
                  setCreateRootDialog((prev) => ({ ...prev, question: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void handleCreateRoot()
                  }
                }}
                placeholder="你想从哪一个问题或概念开始？例如：不定积分的分部积分法怎么推导？"
              />
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() =>
                  setCreateRootDialog({ open: false, flowPosition: null, question: '' })
                }
              >
                取消
              </Button>
              <Button
                variant="primary"
                disabled={!createRootDialog.question.trim()}
                onClick={() => void handleCreateRoot()}
              >
                创建并开始
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 节点删除确认对话框 */}
        <Dialog open={Boolean(nodeToDelete)} onOpenChange={(open) => !open && setNodeToDelete(null)}>
          <DialogContent className="w-[min(420px,100%)]">
            <DialogHeader>
              <DialogTitle>删除节点</DialogTitle>
              <DialogDescription>
                将删除该节点及其全部子节点与对话记录，无法恢复。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setNodeToDelete(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (nodeToDelete) {
                    void deleteNode(nodeToDelete)
                    setNodeToDelete(null)
                  }
                }}
              >
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}