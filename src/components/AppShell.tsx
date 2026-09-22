import { Suspense, useEffect, useRef, useState } from 'react'
import { FolderKanban, Settings, UserRound } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Toaster } from 'sonner'
import { BootstrapError } from '@/components/BootstrapError'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { FirstLoginDialog } from '@/features/me/FirstLoginDialog'
import { cn } from '@/lib/utils'
import { useBootstrap } from '@/stores/bootstrap'
import { useSyncRuntime } from '@/stores/sync-runtime'

const NAV_ITEMS = [
  { to: '/', label: '项目', icon: FolderKanban, end: true },
  { to: '/me', label: '我的', icon: UserRound, end: false },
  { to: '/settings', label: '配置', icon: Settings, end: false },
]

/** 品牌标记（树）：树干 + 两条枝 + 两个节点。 */
function TreeMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="none"
      strokeWidth={1.7}
      strokeLinecap="round"
    >
      <path d="M7 21V6" stroke="currentColor" className="text-line-strong" />
      <path d="M7 12h6" stroke="currentColor" className="text-line-strong" />
      <path d="M7 17h6" stroke="currentColor" className="text-line-strong" />
      <circle cx="17" cy="12" r="3" className="fill-accent stroke-none" />
      <circle cx="17" cy="17" r="3" className="fill-accent/45 stroke-none" />
    </svg>
  )
}

function SplashScreen() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2.5 text-muted">
      <TreeMark />
      <span className="text-sm">正在载入…</span>
    </div>
  )
}

export function AppShell() {
  const bootstrap = useBootstrap()
  const { phase } = bootstrap
  const location = useLocation()
  const isCanvasRoute = location.pathname.startsWith('/p/')

  // 账号与同步的运行期接线挂在这里而不是「我的」页：进不进那一页都要持续同步。
  useSyncRuntime(phase === 'ready')

  // 方案 B：中央独立微型悬浮胶囊状态
  const [capsuleHovered, setCapsuleHovered] = useState(false)
  const leaveTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isCanvasRoute) return
    const handleMouseMove = (event: MouseEvent) => {
      // 仅当鼠标接近窗口正上方中央区域时显现
      const windowWidth = window.innerWidth
      const centerX = windowWidth / 2
      const isNearCenter = Math.abs(event.clientX - centerX) <= 150
      const isNearTop = event.clientY <= 52

      if (isNearCenter && isNearTop) {
        if (leaveTimerRef.current) {
          window.clearTimeout(leaveTimerRef.current)
          leaveTimerRef.current = null
        }
        setCapsuleHovered(true)
      } else if (event.clientY > 68 || !isNearCenter) {
        if (!leaveTimerRef.current && capsuleHovered) {
          leaveTimerRef.current = window.setTimeout(() => {
            setCapsuleHovered(false)
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
  }, [isCanvasRoute, capsuleHovered])

  return (
    <TooltipProvider>
      <div className="relative flex h-screen flex-col overflow-hidden bg-canvas">
        {/* 非工作区页面（/ 、/me 与 /settings）保留顶部通透全宽 Header */}
        {!isCanvasRoute ? (
          <header className="z-30 flex h-13 shrink-0 items-center justify-between border-b border-line/60 px-6">
            <NavLink to="/" className="flex items-center gap-2 text-ink transition-opacity hover:opacity-85">
              <span className="text-muted">
                <TreeMark />
              </span>
              <span className="text-base font-semibold tracking-tight">OpenTreeLearn</span>
            </NavLink>

            <nav className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon
                return (
                  <Tooltip key={item.to} label={item.label}>
                    {/* className 必须是字符串常量：Tooltip 用 radix Slot 克隆子元素，
                        而 Slot 合并 className 时走的是 `[a, b].filter(Boolean).join(' ')`，
                        函数式 className 会被拼成它的源码文本 —— `relative` 随之失效，
                        绝对定位的激活指示层就会改以整页为定位基准铺满视口（页面空白、
                        点击被吞）。激活态配色因此下移到图标层，用 render prop 的 isActive
                        决定，并靠 group-hover 保留整块链接的悬停反馈。 */}
                    <NavLink
                      to={item.to}
                      end={item.end}
                      aria-label={item.label}
                      className="group relative flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-150"
                    >
                      {({ isActive }) => (
                        <>
                          {isActive ? (
                            <span className="absolute inset-0 rounded-md bg-elevated" />
                          ) : null}
                          <Icon
                            className={cn(
                              'relative z-10 h-4 w-4 transition-colors duration-150',
                              isActive ? 'text-accent' : 'text-muted group-hover:text-ink',
                            )}
                          />
                        </>
                      )}
                    </NavLink>
                  </Tooltip>
                )
              })}
            </nav>
          </header>
        ) : (
          /* 方案 B：工作区页面中绝对禁止全宽条带遮挡！
             整层使用 pointer-events-none，无左侧重复 Logo，无任何全宽透明层拦截事件，
             仅在正中央悬浮独立微型导航胶囊，鼠标划过中央顶部时显现，两端完全透传给下层按钮 */
          <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-14 items-start justify-center pt-2">
            <nav
              onMouseEnter={() => {
                if (leaveTimerRef.current) window.clearTimeout(leaveTimerRef.current)
                setCapsuleHovered(true)
              }}
              onMouseLeave={() => {
                leaveTimerRef.current = window.setTimeout(() => {
                  setCapsuleHovered(false)
                  leaveTimerRef.current = null
                }, 240)
              }}
              className={cn(
                'pointer-events-auto flex items-center gap-1 rounded-full border border-line/60 bg-surface/90 p-1 shadow-panel backdrop-blur-md transition-all duration-300 ease-out-expo',
                capsuleHovered
                  ? 'translate-y-0 opacity-100 scale-100'
                  : '-translate-y-4 opacity-0 scale-90 pointer-events-none',
              )}
            >
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon
                return (
                  <Tooltip key={item.to} label={item.label}>
                    {/* 与上方 Header 同因同解：className 保持字符串常量，激活配色放到图标层。 */}
                    <NavLink
                      to={item.to}
                      end={item.end}
                      aria-label={item.label}
                      className="group relative flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-150"
                    >
                      {({ isActive }) => (
                        <>
                          {isActive ? (
                            <span className="absolute inset-0 rounded-full bg-elevated" />
                          ) : null}
                          <Icon
                            className={cn(
                              'relative z-10 h-3.5 w-3.5 transition-colors duration-150',
                              isActive ? 'text-accent' : 'text-muted group-hover:text-ink',
                            )}
                          />
                        </>
                      )}
                    </NavLink>
                  </Tooltip>
                )
              })}
            </nav>
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col">
          {phase === 'ready' ? (
            <Suspense fallback={<SplashScreen />}>
              <Outlet />
            </Suspense>
          ) : phase === 'error' ? (
            <BootstrapError message={bootstrap.message} onRetry={bootstrap.retry} />
          ) : (
            <SplashScreen />
          )}
        </main>

        {/* 首次在某台设备登录时的「本机数据怎么办」：挂在壳上，用户在哪一页都能看到 */}
        <FirstLoginDialog />

        <Toaster
          theme="dark"
          position="bottom-center"
          toastOptions={{
            classNames: {
              toast: 'rounded-lg border border-line bg-elevated text-ink text-sm shadow-panel',
              description: 'text-muted',
            },
          }}
        />
      </div>
    </TooltipProvider>
  )
}
