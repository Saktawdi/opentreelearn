import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import { Brain, Flame, LayoutGrid, Loader2, Maximize2, Network, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
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
import { isBlankCanvasOpen } from '@/lib/blank-canvas'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { CanvasContextMenu, type CanvasContextMenuTarget } from './CanvasContextMenu'
import { buildGraph, type GraphResult, type LearnFlowNode } from './graph'
import { LearnNodeCard } from './LearnNodeCard'
import { LearnNodeDot } from './LearnNodeDot'
import { StarterPanel } from './StarterPanel'
import { useDecayClock } from '@/features/chat/useDecayClock'
import { ReviewWorkspace } from '@/features/review/ReviewWorkspace'
import { dueCounts } from '@/domain/review/enrollment'
import { projectVisibleNodes } from '@/domain/review/center'

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
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const viewModeQuery = searchParams.get('view')
  const isReviewMode = viewModeQuery === 'review'

  // 外层 Provider 的实例 = 右侧微缩导航地图
  const miniApi = useReactFlow()
  const { fitView } = miniApi
  // 展开详情画布拥有独立 store，实例由 FlowApiBridge 注入
  const detailApiRef = useRef<FlowApi | null>(null)

  const openProject = useWorkspaceStore((state) => state.openProject)
  const reset = useWorkspaceStore((state) => state.reset)
  const project = useWorkspaceStore((state) => state.project)
  const workspaceProjectId = useWorkspaceStore((state) => state.projectId)
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
  const summarizingNodeIds = useWorkspaceStore((state) => state.summarizingNodeIds)

  // 保持率热力图：按需开启（默认关闭，保持界面清爽），使用分钟级时钟
  const [showHeatMap, setShowHeatMap] = useState(false)
  const heatNow = useDecayClock()

  // 到期数统计：常驻文字入口显示
  const dueSummary = useMemo(() => dueCounts(nodes, heatNow), [nodes, heatNow])

  // 视图投影：旧复习中心在常规学习树中隐藏，但它的普通后代继续可见
  const visibleNodes = useMemo(() => projectVisibleNodes(nodes), [nodes])

  // 布局状态：右侧地图宽度与折叠状态
  const [mapWidth, setMapWidth] = useState<number>(320)
  const [isMapCollapsed, setIsMapCollapsed] = useState<boolean>(false)
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null)

  // 全局视图模式：'split' (沉浸对话+右侧点树导航) | 'full-canvas' (全屏展开节点详情画布，支持自由拖动节点)
  const [isDetailCanvasOpen, setIsDetailCanvasOpen] = useState(false)
  // 手动收起过空白画布的项目 id：空白项目的自动展开只做一次，不跟用户较劲（见 isBlankCanvas）
  const [blankCanvasClosedFor, setBlankCanvasClosedFor] = useState<string | null>(null)

  // 当前生效的画布实例：详情画布展开时用它自己的，否则用微缩导航地图的
  const activeApi = () =>
    isCanvasOpen && detailApiRef.current ? detailApiRef.current : miniApi

  const [contextMenu, setContextMenu] = useState<CanvasContextMenuTarget | null>(null)

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

  // 全局快捷键：Ctrl/Cmd + M 切换右侧地图展开/收起；详情画布展开时 Esc 退回对话
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault()
        setIsMapCollapsed((v) => !v)
        return
      }
      // 对话框与右键菜单各自响应 Esc（关闭自己），此时不要再把整层画布一起收掉
      if (e.key === 'Escape' && !contextMenu && !createRootDialog.open && !nodeToDelete) {
        setIsDetailCanvasOpen(false)
        // 与「返回对话」同义：空白画布收起后不要再被派生出来，否则会像关不掉
        setBlankCanvasClosedFor(projectId ?? null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [contextMenu, createRootDialog.open, nodeToDelete, projectId])

  /**
   * 首页「今日复习」带 openReviewCenter 进来时，一次性转换为新复习模式：
   * 自动导航到 ?view=review。
   */
  const wantsReviewCenter = Boolean(
    (location.state as { openReviewCenter?: boolean } | null)?.openReviewCenter,
  )
  const navKey = location.key
  const consumedNavKey = useRef<string | null>(null)

  // 模式切换与项目加载解耦：只在 projectId 真正改变时重新 openProject，
  // 改变查询参数（?view=review&session=...）不能清空工作区！
  const loadedProjectIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    if (loadedProjectIdRef.current === projectId) return
    loadedProjectIdRef.current = projectId

    void openProject(projectId).then(() => {
      if (!wantsReviewCenter || consumedNavKey.current === navKey) return
      consumedNavKey.current = navKey
      setSearchParams((prev) => {
        prev.set('view', 'review')
        return prev
      })
    })

    return () => {
      reset()
      loadedProjectIdRef.current = null
    }
  }, [projectId, navKey, wantsReviewCenter, openProject, reset, setSearchParams])

  // 右侧微缩导航地图：始终用点阵紧凑布局，使用投影后的可见节点（隐藏旧复习中心）
  const miniGraph = useMemo(
    () =>
      buildGraph(visibleNodes, messagesByNode, selectedNodeId, {
        miniMapMode: true,
        showHeatMap,
        now: heatNow,
      }),
    [visibleNodes, messagesByNode, selectedNodeId, showHeatMap, heatNow],
  )

  const activeCount = miniGraph.nodes.length
  const isEmpty = activeCount === 0

  /**
   * 空白项目（一个节点都没有）的落地体验：**进来直接就是展开画布** ——
   * 空项目没有对话可看，分栏布局里左边只剩一句「未选中节点」，不如把整块画布给出来，
   * 「第一个问题」的入口就摆在画布正中间（见下面的 StarterPanel）。
   *
   * 判断是纯派生的、不是进入后 setState 的 effect：第一个节点一出现
   * （例如刚在画布上问出根节点）isEmpty 即为假，画布随之收起，回答直接在左边
   * 流式呈现 —— 不需要额外同步，也不会先闪一帧空态。
   * 收起画布会记下「用户不要空白画布占场」（closeDetailCanvas），已有节点的项目不受影响。
   */
  const isBlankCanvas = isBlankCanvasOpen({
    loading,
    projectId,
    workspaceProjectId,
    isEmpty,
    dismissedFor: blankCanvasClosedFor,
  })
  const isCanvasOpen = isDetailCanvasOpen || isBlankCanvas

  /** 展开详情画布：等它自己的实例挂载并同步完节点后，由它自己居中。 */
  const openDetailCanvas = () => {
    setIsDetailCanvasOpen(true)
    window.setTimeout(() => {
      void detailApiRef.current?.fitView({ padding: 0.22, duration: 350, maxZoom: 1.2 })
    }, 80)
  }

  /** 收起画布：同时记下「用户不要空白画布占场」，免得刚收起又被派生出来。 */
  const closeDetailCanvas = () => {
    setIsDetailCanvasOpen(false)
    setBlankCanvasClosedFor(projectId ?? null)
  }

  // 展开详情画布：卡片形态、复用持久化的节点坐标；未展开时不计算
  const detailGraph = useMemo(
    () =>
      isCanvasOpen
        ? buildGraph(visibleNodes, messagesByNode, selectedNodeId, {
            miniMapMode: false,
            summarizingNodeIds,
            showHeatMap,
            now: heatNow,
          })
        : null,
    [visibleNodes, messagesByNode, selectedNodeId, isCanvasOpen, summarizingNodeIds, showHeatMap, heatNow],
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

  /**
   * 详情画布里双击节点 = 对该节点按下「返回对话」：选中它并收起画布，
   * 落点直接就是该节点的对话，省掉「先点节点、再点返回对话」两步。
   */
  const handleNodeDoubleClick = (_: ReactMouseEvent, node: { id: string }) => {
    setContextMenu(null)
    selectNode(node.id)
    closeDetailCanvas()
  }

  const handleNodeDragStop = (
    _event: unknown,
    node: { id: string; position: { x: number; y: number } },
  ) => {
    if (isCanvasOpen) {
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

  // 复习工作区模式
  if (isReviewMode && projectId) {
    return (
      <ReviewWorkspace
        projectId={projectId}
        onLeave={(target) => {
          setSearchParams((prev) => {
            prev.delete('view')
            prev.delete('session')
            return prev
          })
          if (target?.nodeId) {
            selectNode(target.nodeId)
          }
        }}
      />
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
              {isEmpty
                ? '还没有节点：在右边地图里问出第一个问题，或右键空白处新建根节点。'
                : '在右侧地图里点一个节点，或右键空白处新建根节点。'}
            </p>
            <div className="flex items-center gap-2">
              {isEmpty ? (
                <Button variant="secondary" size="sm" onClick={openDetailCanvas}>
                  <Network className="h-3.5 w-3.5" />
                  展开画布
                </Button>
              ) : null}
              {isMapCollapsed ? (
                <Button variant="secondary" size="sm" onClick={() => setIsMapCollapsed(false)}>
                  展开地图
                </Button>
              ) : null}
            </div>
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
            {/* 常驻文字复习入口，带到期数 */}
            <Tooltip label="进入复习工作区">
              <button
                type="button"
                onClick={() =>
                  setSearchParams((prev) => {
                    prev.set('view', 'review')
                    return prev
                  })
                }
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-muted transition-colors hover:text-accent font-medium"
              >
                <Brain className="h-3 w-3 text-accent" />
                <span>复习</span>
                {dueSummary.due > 0 ? (
                  <span className="rounded bg-accent-soft px-1 text-accent tabular-nums">
                    {dueSummary.due}
                  </span>
                ) : null}
              </button>
            </Tooltip>

            <span className="h-3 w-px bg-line/60 mx-0.5" />

            {/* 按需开启的保持率热力图 */}
            <Tooltip label={showHeatMap ? '关闭记忆热力图' : '开启记忆热力图'}>
              <button
                type="button"
                aria-label="切换记忆热力图"
                onClick={() => setShowHeatMap((v) => !v)}
                className={cn(
                  'rounded-sm p-0.5 transition-colors',
                  showHeatMap ? 'text-accent bg-accent-soft' : 'text-muted hover:text-ink',
                )}
              >
                <Flame className="h-3 w-3" />
              </button>
            </Tooltip>

            <span className="text-2xs text-muted">{activeCount} 个节点</span>
            <Tooltip label="重新居中">
              <button
                type="button"
                aria-label="重新居中"
                onClick={() => void fitView({ padding: 0.28, duration: 0.4, maxZoom: 1.4 })}
                className="ml-1 rounded-sm p-0.5 text-muted transition-colors hover:text-ink"
              >
                <LayoutGrid className="h-3 w-3" />
              </button>
            </Tooltip>
            <Tooltip label="展开画布">
              <button
                type="button"
                aria-label="展开画布"
                onClick={openDetailCanvas}
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

        {/*
          空白项目的第一个问题入口：展开画布在时由画布正中间那份负责（见下面的弹层），
          这里只兜底分栏视图 —— 两份同时挂着只会让同一句话被读两遍。
        */}
        {isEmpty && !loading && !isCanvasOpen ? (
          <StarterPanel
            projectName={project?.name ?? '新项目'}
            onSubmit={(question) => startRootNode(question)}
          />
        ) : null}

        <CanvasContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onNodeAction={(kind, nodeId) => {
            selectNode(nodeId)
            void applyAction(kind, nodeId)
          }}
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
      {isCanvasOpen ? (
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
              onNodeDoubleClick={handleNodeDoubleClick}
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
              // 热力图的角度、徽标与掌握度都在节点组件里算：离屏卡片不该参与，
              // 顺便省掉大树上不可见节点的渲染开销
              onlyRenderVisibleElements
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#181c23" />
              <Controls className="!border-line !bg-surface !shadow-panel" />
            </ReactFlow>
          </ReactFlowProvider>

          {/* 空白画布：第一个问题的入口就摆在画布正中间，不必先摸到右键菜单 */}
          {isEmpty && !loading ? (
            <StarterPanel
              projectName={project?.name ?? '新项目'}
              onSubmit={(question) => startRootNode(question)}
            />
          ) : null}

          {/* 顶部浮动条：状态与返回主舞台按钮 */}
          <div className="pointer-events-none absolute left-6 right-6 top-4 z-10 flex items-center justify-between">
            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-line bg-surface/90 px-3 py-1.5 backdrop-blur">
              <span className="text-sm text-ink-soft">画布</span>
              <span className="text-xs text-muted">
                {isEmpty ? '还没有节点' : `${activeCount} 个节点`}
              </span>
              <span className="h-3.5 w-px bg-line/60" />
              <span className="text-xs text-faint">
                {isEmpty ? '输入第一个问题开始' : '双击节点进入对话'}
              </span>
            </div>

            <div className="pointer-events-auto flex items-center gap-1.5">
              {/* 一个节点都没有时，复习/重新布局/居中都没有对象，只留返回对话 */}
              {isEmpty ? null : (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      closeDetailCanvas()
                      setSearchParams((prev) => {
                        prev.set('view', 'review')
                        return prev
                      })
                    }}
                    className="gap-1.5 bg-surface/90 backdrop-blur"
                  >
                    <Brain className="h-3.5 w-3.5 text-accent" />
                    复习工作区
                    {dueSummary.due > 0 ? (
                      <span className="rounded bg-accent-soft px-1 text-accent text-2xs tabular-nums">
                        {dueSummary.due}
                      </span>
                    ) : null}
                  </Button>
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
                    onClick={() =>
                      void detailApiRef.current?.fitView({ padding: 0.22, duration: 400, maxZoom: 1.2 })
                    }
                    className="gap-1.5 bg-surface/90 backdrop-blur"
                  >
                    <Maximize2 className="h-3.5 w-3.5 text-muted" />
                    居中
                  </Button>
                </>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={closeDetailCanvas}
                className="gap-1.5 bg-surface/90 backdrop-blur"
              >
                <X className="h-3.5 w-3.5" />
                返回对话
                <kbd className="rounded border border-line/70 px-1 font-mono text-2xs leading-4 text-muted">
                  Esc
                </kbd>
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}