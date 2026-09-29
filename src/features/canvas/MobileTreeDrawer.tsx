import { AnimatePresence, motion } from 'motion/react'
import { Brain, LayoutGrid, Network, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { EASE_OUT_EXPO } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface MobileTreeDrawerProps {
  open: boolean
  onClose: () => void
  projectName?: string
  activeCount: number
  dueCount?: number
  onOpenReview?: () => void
  onRecenter?: () => void
  children: ReactNode
}

/**
 * 手机端左侧滑出式知识树抽屉：
 * - 响应式收拢桌面端右侧的 ReactFlow 微缩导航画布；
 * - 从左侧平滑滑出，覆盖遮罩层，点选任意节点后自动收起；
 * - 顶部提供项目概览、到期复习入口、一键居中与关闭按钮；
 * - 适配安全区，保证大拇指单手触控操作舒适度。
 */
export function MobileTreeDrawer({
  open,
  onClose,
  projectName,
  activeCount,
  dueCount = 0,
  onOpenReview,
  onRecenter,
  children,
}: MobileTreeDrawerProps) {
  const { t } = useTranslation('canvas')

  return (
    <div className={cn('fixed inset-0 z-50 pointer-events-none', open && 'pointer-events-auto')}>
      {/* 半透明遮罩层 */}
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            aria-hidden="true"
          />
        ) : null}
      </AnimatePresence>

      {/* 抽屉面板主体（保持常驻 DOM，靠 x 轴偏移实现秒开无白屏） */}
      <motion.aside
        initial={false}
        animate={{ x: open ? '0%' : '-100%' }}
        transition={{ duration: 0.28, ease: EASE_OUT_EXPO }}
        className="fixed inset-y-0 left-0 flex w-[min(340px,85vw)] flex-col border-r border-line bg-surface shadow-2xl pt-safe pb-safe"
        aria-label={t('map.drawerAria')}
        aria-hidden={!open}
      >
        {/* 抽屉头部 */}
        <header className="flex h-13 shrink-0 items-center justify-between border-b border-line/60 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent">
              <Network className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-ink">
                {projectName || t('starter.fallbackName')}
              </h2>
              <p className="text-2xs text-muted">
                {t('counts.nodes', { count: activeCount })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {dueCount > 0 && onOpenReview ? (
              <Tooltip label={t('map.reviewTooltip')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    onClose()
                    onOpenReview()
                  }}
                  className="relative text-accent hover:bg-accent-soft"
                >
                  <Brain className="h-4 w-4" />
                  <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-ink">
                    {dueCount}
                  </span>
                </Button>
              </Tooltip>
            ) : null}

            {onRecenter ? (
              <Tooltip label={t('actions.recenter')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onRecenter}
                  className="text-muted hover:text-ink"
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
              </Tooltip>
            ) : null}

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              className="text-muted hover:text-ink"
              aria-label={t('actions.close')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* 抽屉内容区：容纳 ReactFlow 树图 */}
        <div className="relative flex-1 overflow-hidden bg-canvas">
          {children}
        </div>
      </motion.aside>
    </div>
  )
}
