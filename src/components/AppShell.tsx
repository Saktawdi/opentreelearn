import { motion } from 'motion/react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { FolderKanban, Settings } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Toaster } from 'sonner'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useBootstrap } from '@/stores/bootstrap'

const NAV_ITEMS = [
  { to: '/', label: '项目', icon: FolderKanban, end: true },
  { to: '/settings', label: '配置', icon: Settings, end: false },
]

function TreeMark({ animate = true }: { animate?: boolean }) {
  const draw = animate
    ? { initial: { pathLength: 0, opacity: 0 }, animate: { pathLength: 1, opacity: 1 } }
    : {}

  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[22px] w-[22px]"
      fill="none"
      strokeWidth={1.7}
      strokeLinecap="round"
    >
      <motion.path
        d="M7 21V6"
        stroke="currentColor"
        className="text-line-strong"
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        {...draw}
      />
      <motion.path
        d="M7 12h6"
        stroke="currentColor"
        className="text-line-strong"
        transition={{ duration: 0.5, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
        {...draw}
      />
      <motion.path
        d="M7 17h6"
        stroke="currentColor"
        className="text-line-strong"
        transition={{ duration: 0.5, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
        {...draw}
      />
      <motion.circle
        cx="17"
        cy="12"
        r="3"
        className="fill-accent stroke-none"
        initial={animate ? { scale: 0, opacity: 0 } : undefined}
        animate={animate ? { scale: 1, opacity: 1 } : undefined}
        transition={{ duration: 0.45, delay: 0.45, ease: [0.16, 1, 0.3, 1] }}
      />
      <motion.circle
        cx="17"
        cy="17"
        r="3"
        className="fill-accent/45 stroke-none"
        initial={animate ? { scale: 0, opacity: 0 } : undefined}
        animate={animate ? { scale: 1, opacity: 1 } : undefined}
        transition={{ duration: 0.45, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
  )
}

function SplashScreen() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <motion.div
        animate={{ opacity: [0.55, 1, 0.55] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        className="text-ink"
      >
        <TreeMark animate={false} />
      </motion.div>
      <p className="text-[13px] text-muted">正在载入学习地图…</p>
    </div>
  )
}

export function AppShell() {
  const ready = useBootstrap()
  const [headerVisible, setHeaderVisible] = useState(false)
  const leaveTimerRef = useRef<number | null>(null)

  // 增强顶部聚焦检测：全局监听鼠标纵坐标，靠近顶部即刻唤起，并保留离去缓冲
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      // 触发范围大幅增强：窗口顶部 56px 范围内即触发显现
      if (event.clientY <= 56) {
        if (leaveTimerRef.current) {
          window.clearTimeout(leaveTimerRef.current)
          leaveTimerRef.current = null
        }
        setHeaderVisible(true)
      } else if (event.clientY > 72) {
        // 离开 72px 区域后稍作缓冲（240ms），防止边缘抖动消失
        if (!leaveTimerRef.current && headerVisible) {
          leaveTimerRef.current = window.setTimeout(() => {
            setHeaderVisible(false)
            leaveTimerRef.current = null
          }, 240)
        }
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      if (leaveTimerRef.current) window.clearTimeout(leaveTimerRef.current)
    }
  }, [headerVisible])

  return (
    <TooltipProvider>
      <div className="relative flex h-screen flex-col overflow-hidden bg-canvas">
        {/* 顶部超宽热区兜底（高度扩展至 48px） */}
        <div
          onMouseEnter={() => {
            if (leaveTimerRef.current) window.clearTimeout(leaveTimerRef.current)
            setHeaderVisible(true)
          }}
          className="absolute left-0 right-0 top-0 z-40 h-12"
        />

        {/* 浮动悬浮 Header：增强视觉投影与毛玻璃深度 */}
        <header
          onMouseEnter={() => {
            if (leaveTimerRef.current) window.clearTimeout(leaveTimerRef.current)
            setHeaderVisible(true)
          }}
          onMouseLeave={() => {
            leaveTimerRef.current = window.setTimeout(() => {
              setHeaderVisible(false)
              leaveTimerRef.current = null
            }, 240)
          }}
          className={cn(
            'pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-14 items-center justify-between px-6 transition-all duration-300 ease-out-expo',
            headerVisible
              ? 'pointer-events-auto translate-y-0 opacity-100'
              : '-translate-y-full opacity-0',
          )}
        >
          {/* 左侧：Logo 标识与标题 */}
          <NavLink
            to="/"
            className="flex items-center gap-2 rounded-xl border border-line/40 bg-surface/80 px-3 py-1.5 shadow-panel backdrop-blur-md transition-transform hover:scale-105 active:scale-95"
          >
            <span className="text-accent">
              <TreeMark />
            </span>
            <span className="text-[13px] font-semibold tracking-tight text-ink">OpenTreeLearn</span>
          </NavLink>

          {/* 居中：项目和设置图标导航胶囊 */}
          <nav className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line/50 bg-surface/85 p-1 shadow-panel backdrop-blur-md">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <Tooltip key={item.to} label={item.label}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'relative flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-150',
                        isActive ? 'text-accent' : 'text-muted hover:text-ink',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive ? (
                          <motion.span
                            layoutId="appshell-nav-indicator"
                            className="absolute inset-0 rounded-full bg-elevated/90 ring-1 ring-accent/30 shadow-sm"
                            transition={{ type: 'spring', stiffness: 450, damping: 32 }}
                          />
                        ) : null}
                        <motion.div
                          whileHover={{ scale: 1.15 }}
                          whileTap={{ scale: 0.9 }}
                          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                          className="relative z-10 flex items-center justify-center"
                        >
                          <Icon className="h-4 w-4" />
                        </motion.div>
                      </>
                    )}
                  </NavLink>
                </Tooltip>
              )
            })}
          </nav>

          {/* 右侧空占位，保证居中胶囊真正对称居中 */}
          <div className="w-32" />
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          {ready ? (
            <Suspense fallback={<SplashScreen />}>
              <Outlet />
            </Suspense>
          ) : (
            <SplashScreen />
          )}
        </main>

        <Toaster
          theme="dark"
          position="bottom-center"
          toastOptions={{
            style: {
              background: '#171b21',
              border: '1px solid #232830',
              color: '#e8ebef',
              fontSize: '13px',
            },
          }}
        />
      </div>
    </TooltipProvider>
  )
}