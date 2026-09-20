import { motion } from 'motion/react'
import { Suspense } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useBootstrap } from '@/stores/bootstrap'

const NAV_ITEMS = [
  { to: '/', label: '项目', end: true },
  { to: '/settings', label: '配置', end: false },
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

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-canvas">
        <header className="z-30 flex h-13 shrink-0 items-center gap-6 border-b border-line bg-surface/70 px-4 backdrop-blur-sm">
          <NavLink to="/" className="flex items-center gap-2 text-ink">
            <span className="text-accent">
              <TreeMark />
            </span>
            <span className="text-[13.5px] font-semibold tracking-tight">OpenTreeLearn</span>
          </NavLink>

          <nav className="flex items-center gap-0.5">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'relative rounded-lg px-3 py-1.5 text-[13px] transition-colors duration-150',
                    isActive ? 'text-ink' : 'text-muted hover:text-ink-soft',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <motion.span
                        layoutId="nav-pill"
                        className="absolute inset-0 rounded-lg border border-line bg-elevated"
                        transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                      />
                    ) : null}
                    <span className="relative z-10">{item.label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <span className="ml-auto text-[11.5px] text-muted/70">
            对话即内容 · 树即学习路径
          </span>
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