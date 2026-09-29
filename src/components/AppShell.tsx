import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FolderKanban, Settings, UserRound } from 'lucide-react'
import { motion } from 'motion/react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Toaster } from 'sonner'
import { BootstrapError } from '@/components/BootstrapError'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { FirstLoginDialog } from '@/features/me/FirstLoginDialog'
import { ProjectsPageSkeleton } from '@/features/projects/ProjectsPageSkeleton'
import { EASE_OUT_EXPO } from '@/lib/motion'
import { useIsMobile } from '@/lib/use-is-mobile'
import { cn } from '@/lib/utils'
import { useBootstrap } from '@/stores/bootstrap'
import { useSyncRuntime } from '@/stores/sync-runtime'

// labelKey 是 i18n 键：文案在渲染处用 t() 解析（当前语言），模块级常量只存键
const NAV_ITEMS = [
  { to: '/', labelKey: 'nav.projects', icon: FolderKanban, end: true },
  { to: '/me', labelKey: 'nav.me', icon: UserRound, end: false },
  { to: '/settings', labelKey: 'nav.settings', icon: Settings, end: false },
] as const

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
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 items-center justify-center gap-2.5 text-muted">
      <TreeMark />
      <span className="text-sm">{t('splash.loading')}</span>
    </div>
  )
}

export function AppShell() {
  const { t } = useTranslation()
  const bootstrap = useBootstrap()
  const { phase } = bootstrap
  const location = useLocation()
  const isCanvasRoute = location.pathname.startsWith('/p/')
  const isMobile = useIsMobile()

  // 账号与同步的运行期接线挂在这里而不是「我的」页：进不进那一页都要持续同步。
  useSyncRuntime(phase === 'ready')

  // 方案 B：中央微型导航胶囊。不做常驻图标（常驻图标是视觉噪音）——鼠标靠近顶部中央时
  // 胶囊以滑出+脉冲动效揭示，动效本身就是引导；键盘/触屏走一枚隐形可聚焦热点，
  // 聚焦即展开（focus ring 可见），点按可把胶囊钉住。
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  // 胶囊当前是否展开（钉住 / 悬停 / 键盘聚焦 任一成立）
  const revealed = pinned || hovered || focused

  // 进出工作区的「航班交接」：页头右上角与顶部中央胶囊里的三枚导航图标共享
  // layoutId，路由切换的同一帧里旧图标卸载、新图标从旧位置起飞（motion 共享
  // 布局动画），而不是右边凭空消失、中间凭空出现。进入方向上胶囊先短暂现形
  // 「接机」，图标落位后再淡出成待唤醒的呼吸圆点；离开方向上图标直接从中央
  // 飞回右上角常驻位，页头同时淡入。
  const [navHandoff, setNavHandoff] = useState(false)
  const prevCanvasRouteRef = useRef(isCanvasRoute)
  useLayoutEffect(() => {
    // 首次挂载不交接：硬刷新直达工作区没有「上一个位置」，胶囊保持待唤醒
    if (prevCanvasRouteRef.current === isCanvasRoute) return
    prevCanvasRouteRef.current = isCanvasRoute
    setNavHandoff(true)
    const timer = window.setTimeout(() => setNavHandoff(false), 600)
    return () => window.clearTimeout(timer)
  }, [isCanvasRoute])

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

  useEffect(() => {
    if (!pinned) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('#global-nav') && !target?.closest('[aria-controls="global-nav"]')) {
        setPinned(false)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [pinned])

  return (
    <TooltipProvider>
      <div className="relative flex h-dvh flex-col overflow-hidden bg-canvas">
        {/* 非工作区页面（/ 、/me 与 /settings）保留顶部通透全宽 Header */}
        {!isCanvasRoute ? (
          /* 从工作区返回时页头淡入接住飞回的图标；进场淡入不挡图标飞行。 */
          <motion.header
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25, ease: EASE_OUT_EXPO }}
            className="z-30 flex h-13 shrink-0 items-center justify-between border-b border-line/60 px-4 sm:px-6 pt-safe"
          >
            <NavLink to="/" className="flex items-center gap-2 text-ink transition-opacity hover:opacity-85">
              <span className="text-muted">
                <TreeMark />
              </span>
              <span className="text-sm sm:text-base font-semibold tracking-tight">OpenTreeLearn</span>
            </NavLink>

            {/* 顶部居中/右侧胶囊 Tab 导航菜单 */}
            <nav className="flex items-center gap-1 rounded-full border border-line/60 bg-surface/90 p-1 shadow-panel backdrop-blur-md">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon
                return (
                  <Tooltip key={item.to} label={t(item.labelKey)}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      aria-label={t(item.labelKey)}
                      className="group relative flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-full transition-colors duration-150"
                    >
                      {({ isActive }) => (
                        <>
                          {isActive ? (
                            <span className="absolute inset-0 rounded-full bg-elevated" />
                          ) : null}
                          <motion.span
                            layoutId={`global-nav-icon-${item.to}`}
                            transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
                            className="relative z-10 flex"
                          >
                            <Icon
                              className={cn(
                                'h-3.5 w-3.5 sm:h-4 sm:w-4 transition-colors duration-150',
                                isActive ? 'text-accent' : 'text-muted group-hover:text-ink',
                              )}
                            />
                          </motion.span>
                        </>
                      )}
                    </NavLink>
                  </Tooltip>
                )
              })}
            </nav>
          </motion.header>
        ) : !isMobile ? (
          /* 方案 B：桌面端工作区页面保留居中隐形热点与悬浮胶囊 */
          <div
            className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-14 items-start justify-center pt-2 pt-safe"
            onFocus={() => {
              cancelClose()
              setFocused(true)
            }}
            onBlur={scheduleClose}
          >
            <button
              type="button"
              aria-label={t('nav.show')}
              aria-expanded={revealed}
              aria-controls="global-nav"
              onClick={() => setPinned((v) => !v)}
              onMouseEnter={() => {
                cancelClose()
                setHovered(true)
              }}
              onMouseLeave={scheduleClose}
              className="pointer-events-auto flex h-8 w-8 sm:h-7 sm:w-7 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {/* 常驻的克制动效提示：三枚小圆点缓缓呼吸，示意「这里可以唤出点什么」。
                  胶囊展开后淡出让位；reduced-motion 下静置不呼吸。 */}
              <span
                aria-hidden
                className={cn(
                  'flex items-center gap-[3px] transition-opacity duration-200',
                  revealed || navHandoff ? 'opacity-0' : 'opacity-100',
                )}
              >
                <span className="h-1 w-1 animate-nav-hint rounded-full bg-faint [animation-delay:0ms] motion-reduce:animate-none" />
                <span className="h-1 w-1 animate-nav-hint rounded-full bg-faint [animation-delay:400ms] motion-reduce:animate-none" />
                <span className="h-1 w-1 animate-nav-hint rounded-full bg-faint [animation-delay:800ms] motion-reduce:animate-none" />
              </span>
            </button>
            <nav
              id="global-nav"
              onMouseEnter={() => {
                cancelClose()
                setHovered(true)
              }}
              onMouseLeave={scheduleClose}
              className={cn(
                'absolute top-10 flex items-center gap-1 rounded-full border border-line/60 bg-surface/90 p-1 shadow-panel backdrop-blur-md transition-all duration-300 ease-out-expo',
                revealed
                  ? 'pointer-events-auto translate-y-0 scale-100 opacity-100 animate-nav-glint'
                  : navHandoff
                    ? 'pointer-events-auto translate-y-0 scale-100 opacity-100'
                    : 'pointer-events-none -translate-y-2 scale-95 opacity-0',
              )}
            >
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon
                return (
                  <Tooltip key={item.to} label={t(item.labelKey)}>
                    {/* 与上方 Header 同因同解：className 保持字符串常量，激活配色放到图标层。 */}
                    <NavLink
                      to={item.to}
                      end={item.end}
                      aria-label={t(item.labelKey)}
                      className="group relative flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-150"
                    >
                      {({ isActive }) => (
                        <>
                          {isActive ? (
                            <span className="absolute inset-0 rounded-full bg-elevated" />
                          ) : null}
                          <motion.span
                            layoutId={`global-nav-icon-${item.to}`}
                            transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
                            className="relative z-10 flex"
                          >
                            <Icon
                              className={cn(
                                'h-3.5 w-3.5 transition-colors duration-150',
                                isActive ? 'text-accent' : 'text-muted group-hover:text-ink',
                              )}
                            />
                          </motion.span>
                        </>
                      )}
                    </NavLink>
                  </Tooltip>
                )
              })}
            </nav>
          </div>
        ) : null}

        <main className="flex min-h-0 flex-1 flex-col">
          {phase === 'ready' ? (
            <Suspense fallback={<SplashScreen />}>
              <Outlet />
            </Suspense>
          ) : phase === 'error' ? (
            <BootstrapError message={bootstrap.message} onRetry={bootstrap.retry} />
          ) : // 启动期首页用页面形状的骨架屏占位：那行孤零零的「正在载入…」
          // 换成项目列表的骨架，就绪瞬间也没有布局跳动；其余路由保持原样。
          location.pathname === '/' ? (
            <ProjectsPageSkeleton />
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
