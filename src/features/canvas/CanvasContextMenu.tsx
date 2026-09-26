import {
  Archive,
  GitBranch,
  LayoutGrid,
  Maximize2,
  Plus,
  RotateCcw,
  Trash2,
  Waypoints,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NODE_ACTION_HINT_KEY, type NodeActionKind } from '@/domain/node-ops/actions'
import { EXIT_FAST } from '@/lib/motion'

export type CanvasContextMenuTarget =
  | { type: 'node'; nodeId: string; x: number; y: number }
  | { type: 'pane'; x: number; y: number; flowPosition: { x: number; y: number } }

interface CanvasContextMenuProps {
  /** 挂载期间必非空：是否渲染由 CanvasPage 的 AnimatePresence 决定，退场动画期间保持最后一份定位。 */
  menu: CanvasContextMenuTarget
  onClose: () => void
  onNodeAction: (kind: NodeActionKind, nodeId: string) => void
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
  hint,
  danger,
  disabled,
  onClick,
}: {
  icon: ReactNode
  label: string
  /** 第二行落点说明：分支/发散的区别只看菜单猜不出来，要写在按钮上。 */
  hint?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
        disabled
          ? 'cursor-not-allowed text-faint'
          : danger
            ? 'text-danger hover:bg-danger-soft'
            : 'text-ink-soft hover:bg-elevated hover:text-ink'
      }`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        {hint ? <span className="mt-0.5 block text-2xs leading-snug text-faint">{hint}</span> : null}
      </span>
    </button>
  )
}

function MenuSeparator() {
  return <div className="my-1 h-px bg-line" />
}

export function CanvasContextMenu({
  menu,
  onClose,
  onNodeAction,
  onArchiveNode,
  onDeleteNode,
  onCreateRootAt,
  onRelayout,
  onFitView,
  onResetView,
}: CanvasContextMenuProps) {
  const { t } = useTranslation('canvas')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
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

  const menuWidth = 188
  // 带第二行说明的菜单项更高：三个创建动作各多一行
  const menuHeight = menu.type === 'node' ? 268 : 152
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
    <motion.div
      ref={containerRef}
      style={{ left: x, top: y }}
      exit={{ opacity: 0, transition: EXIT_FAST }}
      className="menu-pop fixed z-50 min-w-[188px] rounded-lg border border-line bg-surface p-1 shadow-panel"
    >
      {menu.type === 'node' ? (
        <>
          <MenuItem
            icon={<Plus className="h-3.5 w-3.5" />}
            label={t('menu.newChild')}
            hint={t(`common:${NODE_ACTION_HINT_KEY.child}`)}
            onClick={() => {
              onNodeAction('child', menu.nodeId)
              onClose()
            }}
          />
          <MenuItem
            icon={<GitBranch className="h-3.5 w-3.5" />}
            label={t('menu.branch')}
            hint={t(`common:${NODE_ACTION_HINT_KEY.branch}`)}
            onClick={() => {
              onNodeAction('branch', menu.nodeId)
              onClose()
            }}
          />
          <MenuItem
            icon={<Waypoints className="h-3.5 w-3.5" />}
            label={t('menu.diverge')}
            hint={t(`common:${NODE_ACTION_HINT_KEY.diverge}`)}
            onClick={() => {
              onNodeAction('diverge', menu.nodeId)
              onClose()
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Archive className="h-3.5 w-3.5" />}
            label={t('menu.archiveSubtree')}
            onClick={() => {
              onArchiveNode(menu.nodeId)
              onClose()
            }}
          />
          <MenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label={t('menu.deleteSubtree')}
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
            label={t('menu.newRootHere')}
            onClick={() => {
              onCreateRootAt(menu.flowPosition)
              onClose()
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<LayoutGrid className="h-3.5 w-3.5" />}
            label={t('actions.relayout')}
            onClick={() => {
              onRelayout()
              onClose()
            }}
          />
          <MenuItem
            icon={<Maximize2 className="h-3.5 w-3.5" />}
            label={t('actions.center')}
            onClick={() => {
              onFitView()
              onClose()
            }}
          />
          <MenuItem
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label={t('actions.resetView')}
            onClick={() => {
              onResetView()
              onClose()
            }}
          />
        </>
      )}
    </motion.div>
  )
}
