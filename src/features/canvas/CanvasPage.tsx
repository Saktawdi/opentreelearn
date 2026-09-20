import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import { LayoutGrid, Loader2, Maximize2, Network, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
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
import { buildGraph, type GraphResult, type LearnFlowNode } from './graph'
import { LearnNodeCard } from './LearnNodeCard'
import { LearnNodeDot } from './LearnNodeDot'
import { StarterPanel } from './StarterPanel'

const nodeTypes = {
  learn: LearnNodeCard,
  dot: LearnNodeDot,
}

const EMPTY_GRAPH: GraphResult = { nodes: [], edges: [] }

type FlowApi = ReturnType<typeof useReactFlow>

/**
 * 把当前 Provider 作用域内的 React Flow 实例暴露给外层。
 * 展开详情画布拥有独立的 ReactFlowProvider（独立 store），因此它的
 * fitView / setViewport / screenToFlowPosition 必须走它自己的实例。
 */
function FlowApiBridge({ apiRef }: { apiRef: { current: FlowApi | null } }) {
  const api = useReactFlow()

  useEffect(() => {
    apiRef.current = api
    return () => {
      apiRef.current = null
    }
  }, [api, apiRef])

  return null
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
  // 外层 Provider 的实例 = 右侧微缩导航地图
  const miniApi = useReactFlow()
  const { fitView } = miniApi
  // 展开详情画布拥有独立 store，实例由 FlowApiBridge 注入
  const detailApiRef = useRef<FlowApi | null>(null)

  const openProject = useWorkspaceStore((state) => state.openProject)
  const reset = useWorkspaceStore((state) => state.reset)
  const project = useWorkspaceStore((state) => state.project)
  const nodes = useWorkspaceStore((state) => state.nodes)
  const messagesByNode = useWorkspaceStore((state) => state.messagesByNode)
  const selectedNodeId = useWorkspaceStore((state) => state.selectedNodeId)
  const loading = useWorkspaceStore((state) => state.loading)
  const error = useWorkspaceStore((state) => state.error)
  const selectNode = useWorkspaceStore((state) => state.selectNode)
  const setNodePosition = useWorkspaceStore((state) => state.setNodePosition)
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

  // 全局视图模式：'split' (沉浸对话+右侧点树导航) | 'full-canvas' (全屏展开节点详情画布，支持自由拖动节点)
  const [isDetailCanvasOpen, setIsDetailCanvasOpen] = useState(false)

  // 当前生效的画布实例：详情画布展开时用它自己的，否则用微缩导航地图的
  const activeApi = () =>
    isDetailCanvasOpen && detailApiRef.current ? detailApiRef.current : miniApi

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

  // 右侧微缩导航地图：始终用点阵紧凑布局
  const miniGraph = useMemo(
    () => buildGraph(nodes, messagesByNode, selectedNodeId, { miniMapMode: true }),
    [nodes, messagesByNode, selectedNodeId],
  )

  // 展开详情画布：卡片形态、复用持久化的节点坐标；未展开时不计算
  const detailGraph = useMemo(
    () =>
      isDetailCanvasOpen
        ? buildGraph(nodes, messagesByNode, selectedNodeId, { miniMapMode: false })
        : null,
    [nodes, messagesByNode, selectedNodeId, isDetailCanvasOpen],
  )
  const detailGeometry = detailGraph ?? EMPTY_GRAPH

  // 两个 ReactFlow 各自持有独立 store 与节点状态：
  // 共享同一个 store 时，详情画布卸载会 reset 掉导航地图的 nodeLookup，导致点阵节点整体消失
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(miniGraph.nodes)

  useEffect(() => {
    setFlowNodes(miniGraph.nodes)
  }, [miniGraph, setFlowNodes])

  const [detailNodes, setDetailNodes, onDetailNodesChange] = useNodesState<LearnFlowNode>([])

  useEffect(() => {
    setDetailNodes(detailGeometry.nodes)
  }, [detailGeometry, setDetailNodes])

  const activeCount = miniGraph.nodes.length
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

  const handleNodeDragStop = (
    _event: unknown,
    node: { id: string; position: { x: number; y: number } },
  ) => {
    if (isDetailCanvasOpen) {
      void setNodePosition(node.id, node.position)
    }
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
    const flowPosition = activeApi().screenToFlowPosition({
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
        <p className="text-sm text-ink">{error}</p>
        <Link to="/" className="text-sm text-accent underline underline-offset-4">
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
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-ink-soft">未选中节点</p>
            <p className="max-w-xs text-xs leading-relaxed text-muted">
              在右侧地图里点一个节点，或右键空白处新建根节点。
            </p>
            {isMapCollapsed ? (
              <Button variant="secondary" size="sm" onClick={() => setIsMapCollapsed(false)}>
                展开地图
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {/* 左右两栏之间的拖拽调宽手柄 */}
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
          className="relative z-30 w-px shrink-0 cursor-col-resize bg-line/60 transition-colors hover:bg-accent/50"
        />
      ) : null}

      {/* 右侧：知识树微缩导航地图 */}
      <div
        style={{ width: isMapCollapsed ? 0 : mapWidth }}
        className={cn(
          'relative flex h-full flex-col overflow-hidden bg-canvas transition-[width] duration-200 ease-in-out',
          isMapCollapsed && 'pointer-events-none opacity-0',
        )}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={miniGraph.edges}
          onNodesChange={onNodesChange}
          onNodeDragStop={handleNodeDragStop}
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
          <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-line bg-surface/90 px-2 py-1 backdrop-blur">
            <span className="text-2xs text-muted">{activeCount} 个节点</span>
            <Tooltip label="重新居中">
              <button
                type="button"
                onClick={() => void fitView({ padding: 0.28, duration: 0.4, maxZoom: 1.4 })}
                className="ml-1 rounded-sm p-0.5 text-muted transition-colors hover:text-ink"
              >
                <LayoutGrid className="h-3 w-3" />
              </button>
            </Tooltip>
            <Tooltip label="展开画布">
              <button
                type="button"
                onClick={() => {
                  setIsDetailCanvasOpen(true)
                  // 等详情画布自己的实例挂载并同步完节点后，再由它自己居中
                  window.setTimeout(() => {
                    void detailApiRef.current?.fitView({ padding: 0.2, duration: 350, maxZoom: 1 })
                  }, 80)
                }}
                className="rounded-sm p-0.5 text-muted transition-colors hover:text-ink"
              >
                <Network className="h-3 w-3" />
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
          onFitView={() => void activeApi().fitView({ padding: 0.34, duration: 0.5, maxZoom: 1 })}
          onResetView={() =>
            void activeApi().setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 400 })
          }
        />

        {/* 在此处新建根节点对话框 */}
        <Dialog
          open={createRootDialog.open}
          onOpenChange={(open) => {
            if (!open) setCreateRootDialog({ open: false, flowPosition: null, question: '' })
          }}
        >
          <DialogContent className="w-[min(480px,100%)]">
            <DialogHeader>
              <DialogTitle>新建根节点</DialogTitle>
            </DialogHeader>
            <div className="py-1">
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
                placeholder="例如：不定积分的分部积分法怎么推导？"
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
                创建
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 节点删除确认对话框 */}
        <Dialog open={Boolean(nodeToDelete)} onOpenChange={(open) => !open && setNodeToDelete(null)}>
          <DialogContent className="w-[min(400px,100%)]">
            <DialogHeader>
              <DialogTitle>删除节点</DialogTitle>
              <DialogDescription>
                会连同它的全部子节点与对话一起删除，无法恢复。
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
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* 全屏展开的节点详情画布弹层（原节点卡片/支持拖动节点模式）
          必须独占一个 ReactFlowProvider：与导航地图共享 store 时，本层卸载会 reset 掉地图的节点查找表 */}
      {isDetailCanvasOpen ? (
        <div className="reveal-layer absolute inset-0 z-40 flex flex-col bg-canvas">
          <ReactFlowProvider>
            <FlowApiBridge apiRef={detailApiRef} />
            <ReactFlow
              nodes={detailNodes}
              edges={detailGeometry.edges}
              onNodesChange={onDetailNodesChange}
              onNodeDragStop={handleNodeDragStop}
              nodeTypes={nodeTypes}
              onNodeClick={handleNodeClick}
              onNodeContextMenu={handleNodeContextMenu}
              onPaneContextMenu={handlePaneContextMenu}
              onPaneClick={() => {
                setContextMenu(null)
              }}
              fitView
              fitViewOptions={{ padding: 0.22, maxZoom: 1.2 }}
              minZoom={0.2}
              maxZoom={2.4}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#181c23" />
              <Controls className="!border-line !bg-surface !shadow-panel" />
            </ReactFlow>
          </ReactFlowProvider>

          {/* 顶部浮动条：状态与返回主舞台按钮 */}
          <div className="pointer-events-none absolute left-6 right-6 top-4 z-10 flex items-center justify-between">
            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-line bg-surface/90 px-3 py-1.5 backdrop-blur">
              <span className="text-sm text-ink-soft">画布</span>
              <span className="text-xs text-muted">{activeCount} 个节点</span>
            </div>

            <div className="pointer-events-auto flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void relayout()}
                className="gap-1.5 bg-surface/90 backdrop-blur"
              >
                <LayoutGrid className="h-3.5 w-3.5 text-muted" />
                重新布局
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void detailApiRef.current?.fitView({ padding: 0.22, duration: 400, maxZoom: 1.2 })}
                className="gap-1.5 bg-surface/90 backdrop-blur"
              >
                <Maximize2 className="h-3.5 w-3.5 text-muted" />
                居中
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsDetailCanvasOpen(false)}
                className="gap-1.5 bg-surface/90 backdrop-blur"
              >
                <X className="h-3.5 w-3.5" />
                返回对话
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}