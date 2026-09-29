import { useSyncExternalStore } from 'react'

const MOBILE_BREAKPOINT = 768

/**
 * 订阅媒体查询变动（支持 SSR 降级与客户端无撕裂读取）。
 */
function subscribe(callback: () => void) {
  if (typeof window === 'undefined') return () => {}
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches
}

function getServerSnapshot(): boolean {
  return false
}

export function getIsMobileSnapshot(): boolean {
  return getSnapshot()
}

export function subscribeMobileMediaQuery(callback: () => void): () => void {
  return subscribe(callback)
}

/**
 * 判断当前是否处于移动端视口（屏幕宽度 < 768px）。
 * 基于 React 18/19 的 useSyncExternalStore，保证渲染期无数据撕裂与副作用跳变。
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
