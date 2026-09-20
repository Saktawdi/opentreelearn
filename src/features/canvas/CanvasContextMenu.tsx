import {
  Archive,
  GitBranch,
  LayoutGrid,
  Maximize2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Waypoints,
} from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import type { NodeActionKind } from '@/domain/node-ops/actions'

export type CanvasContextMenuTarget =
  | { type: 'node'; nodeId: string; x: number; y: number }
  | { type: 'pane'; x: number; y: number; flowPosition: { x: number; y: number } }

interface CanvasContextMenuProps {
  menu: CanvasContextMenuTarget | null
  onClose: () => void
  hasSummaryModel: boolean
  onNodeAction: (kind: NodeActionKind, nodeId: string) => void
  onRefreshSummary: (nodeId: string) => void
  onArchiveNode: (nodeId: string) => void
  onDeleteNode: (nodeId: string) => void
  onCreateRootAt: (flowPosition: { x: number; y: number }) => void
  onRelayout: () => void
  onFitView: () => void
  onResetView: () => void
}

function MenuItem({
  icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: ReactNode
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
        disabled
          ? 'cursor-not-allowed text-muted/40'
          : danger
            ? 'text-danger hover:bg-danger-soft'
            : 'text-ink-soft hover:bg-elevated hover:text-ink'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}

function MenuSeparator() {
  return <div className="my-1 h-px bg-line" />
}

export function CanvasContextMenu({
  menu,
  onClose,
  hasSummaryModel,
  onNodeAction,
  onRefreshSummary,
  onArchiveNode,
  onDeleteNode,
  onCreateRootAt,
  onRelayout,
  onFitView,
  onResetView,
}: CanvasContextMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }

    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', onClose, true)

    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [menu, onClose])

  if (!menu) return null

  const menuWidth = 196
  const menuHeight = menu.type === 'node' ? 240 : 160
  const padding = 12

  let x = menu.x
  let y = menu.y

  if (typeof window !== 'undefined') {
    if (x + menuWidth > window.innerWidth - padding) {
      x = Math.max(padding, window.innerWidth - menuWidth - padding)
    }
    if (y + menuHeight > window.innerHeight - padding) {
      y = Math.max(padding, window.innerHeight - menuHeight - padding)
    }
  }

  return (
    <div
      ref={containerRef}
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-[196px] rounded-xl border border-line bg-surface/96 p-1.5 shadow-panel backdrop-blur animate-in fade-in-0 zoom-in-95 duration-100"
    >
      {menu.type === 'node' ? (
        <>
          <MenuItem
            icon={<Plus className="h-3.5 w-3.5" />}
            label="新建空白子节点"
            onClick={() => {
              onNodeAction('child', menu.nodeId)
              onClose()
            }}
          />
          <MenuItem
            icon={<GitBranch className="h-3.5 w-3.5" />}
            label="最新消息分支"
            onClick={() => {
              onNodeAction('branch', menu.nodeId)
              onClose()
            }}
          />
          <MenuItem
            icon={<Waypoints className="h-3.5 w-3.5" />}
            label="最新消息发散"
            onClick={() => {
              onNodeAction('diverge', menu.nodeId)
              onClose()
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label="重新生成摘要"
            disabled={!hasSummaryModel}
            onClick={() => {
              onRefreshSummary(menu.nodeId)
              onClose()
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Archive className="h-3.5 w-3.5" />}
            label="归档（含子树）"
            onClick={() => {
              onArchiveNode(menu.nodeId)
              onClose()
            }}
          />
          <MenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="删除（含子树）"
            danger
            onClick={() => {
              onDeleteNode(menu.nodeId)
              onClose()
            }}
          />
        </>
      ) : (
        <>
          <MenuItem
            icon={<Plus className="h-3.5 w-3.5" />}
            label="在此处新建根节点"
            onClick={() => {
              onCreateRootAt(menu.flowPosition)
              onClose()
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<LayoutGrid className="h-3.5 w-3.5" />}
            label="重新布局"
            onClick={() => {
              onRelayout()
              onClose()
            }}
          />
          <MenuItem
            icon={<Maximize2 className="h-3.5 w-3.5" />}
            label="自适应视图"
            onClick={() => {
              onFitView()
              onClose()
            }}
          />
          <MenuItem
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label="重置视图"
            onClick={() => {
              onResetView()
              onClose()
            }}
          />
        </>
      )}
    </div>
  )
}
