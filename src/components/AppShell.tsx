import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
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

  // 方案 B：中央微型导航胶囊。不做常驻图标（常驻图标是视觉噪音）——鼠标靠近顶部中央时
  // 胶囊以滑出+脉冲动效揭示，动效本身就是引导；键盘/触屏走一枚隐形可聚焦热点，
  // 聚焦即展开（focus ring 可见），点按可把胶囊钉住。
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const closeTimerRef = useRef<number | null>(null)

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])
  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false)
      setFocused(false)
      closeTimerRef.current = null
    }, 240)
  }, [cancelClose])

  useEffect(() => {
    if (!isCanvasRoute) return
    const handleMouseMove = (event: MouseEvent) => {
      const centerX = window.innerWidth / 2
      const nearCenter = Math.abs(event.clientX - centerX) <= 150
      const nearTop = event.clientY <= 52
      // 迟滞：开区小、关区大，从图标区移动到胶囊的路上不会中途收起
      const inCloseZone = Math.abs(event.clientX - centerX) <= 190 && event.clientY <= 110
      if (nearCenter && nearTop) {
        cancelClose()
        setHovered(true)
      } else if (!inCloseZone) {
        scheduleClose()
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      cancelClose()
    }
  }, [isCanvasRoute, cancelClose, scheduleClose])

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
             整层 pointer-events-none，无任何全宽透明层拦截事件，两端完全透传给下层按钮。
             中央顶部只有一枚隐形热点（聚焦/点按时才以 focus ring 现形），
             鼠标靠近时胶囊滑出 + 琥珀脉冲，动效即引导。 */
          <div
            className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-14 items-start justify-center pt-2"
            onFocus={() => {
              cancelClose()
              setFocused(true)
            }}
            onBlur={scheduleClose}
          >
            <button
              type="button"
              aria-label="显示导航"
              aria-expanded={pinned || hovered || focused}
              aria-controls="global-nav"
              onClick={() => setPinned((v) => !v)}
              className="pointer-events-auto h-7 w-7 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            />
            <nav
              id="global-nav"
              onMouseEnter={() => {
                cancelClose()
                setHovered(true)
              }}
              onMouseLeave={scheduleClose}
              className={cn(
                'absolute top-10 flex items-center gap-1 rounded-full border border-line/60 bg-surface/90 p-1 shadow-panel backdrop-blur-md transition-all duration-300 ease-out-expo',
                pinned || hovered || focused
                  ? 'pointer-events-auto translate-y-0 scale-100 opacity-100 animate-nav-glint'
                  : 'pointer-events-none -translate-y-2 scale-95 opacity-0',
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
