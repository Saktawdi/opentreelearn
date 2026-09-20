import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import { GitBranch, LayoutGrid, Loader2, Maximize2, Plus, Waypoints } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import type { NodeActionKind } from '@/domain/node-ops/actions'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { buildGraph } from './graph'
import { LearnNodeCard } from './LearnNodeCard'
import { StarterPanel } from './StarterPanel'

const nodeTypes = { learn: LearnNodeCard }

export function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace />
    </ReactFlowProvider>
  )
}

function CanvasWorkspace() {
  const { projectId } = useParams<{ projectId: string }>()
  const { fitView } = useReactFlow()

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

  const [panelWidth, setPanelWidth] = useState(432)
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    if (projectId) void openProject(projectId)
    return () => {
      reset()
    }
  }, [projectId, openProject, reset])

  const graph = useMemo(
    () => buildGraph(nodes, messagesByNode, selectedNodeId),
    [nodes, messagesByNode, selectedNodeId],
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

  const handleAction = (kind: NodeActionKind) => {
    if (!selectedNodeId) return
    void applyAction(kind, selectedNodeId)
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
    <div className="relative flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1">
        <ReactFlow
          nodes={flowNodes}
          edges={graph.edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => selectNode(node.id)}
          onNodeDragStop={(_, node) => void setNodePosition(node.id, node.position)}
          onPaneClick={() => selectNode(null)}
          fitView
          fitViewOptions={{ padding: 0.34, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.8}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1c2129" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>

        <div className="pointer-events-none absolute left-4 top-4 flex max-w-[calc(100%-2rem)] items-center">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-line bg-surface/92 p-1 shadow-panel backdrop-blur">
            <Link
              to="/"
              className="max-w-[220px] truncate rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-elevated"
            >
              {project?.name ?? '项目'}
            </Link>
            <Badge tone="neutral" className="mr-1.5">
              {activeCount} 节点
            </Badge>

            <span className="mx-1 h-5 w-px bg-line" />

            <Tooltip label="新建空白子节点">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!selectedNodeId}
                onClick={() => handleAction('child')}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip label="从最新消息分支（继承上下文）">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!selectedNodeId}
                onClick={() => handleAction('branch')}
              >
                <GitBranch className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip label="从最新消息横向发散（继承上下文）">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!selectedNodeId}
                onClick={() => handleAction('diverge')}
              >
                <Waypoints className="h-4 w-4" />
              </Button>
            </Tooltip>

            <span className="mx-1 h-5 w-px bg-line" />

            <Tooltip label="重新布局（清除手动位置）">
              <Button variant="ghost" size="icon-sm" onClick={() => void relayout()}>
                <LayoutGrid className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip label="适配视图">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void fitView({ padding: 0.34, duration: 0.5, maxZoom: 1 })}
              >
                <Maximize2 className="h-4 w-4" />
              </Button>
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
      </div>

      <AnimatePresence initial={false}>
        {selectedNodeId ? (
          <motion.div
            key="chat-panel"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="relative h-full shrink-0 overflow-hidden border-l border-line"
          >
            <div style={{ width: panelWidth }} className="h-full">
              <ChatPanel nodeId={selectedNodeId} onClose={() => selectNode(null)} />
            </div>
            <div
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                resizeState.current = { startX: event.clientX, startWidth: panelWidth }
              }}
              onPointerMove={(event) => {
                if (!resizeState.current) return
                const delta = resizeState.current.startX - event.clientX
                setPanelWidth(
                  Math.min(Math.max(resizeState.current.startWidth + delta, 340), 760),
                )
              }}
              onPointerUp={(event) => {
                resizeState.current = null
                event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              className="absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-accent/50"
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}