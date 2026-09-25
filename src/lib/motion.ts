import type { Transition } from 'motion/react'

/*
 * 全项目共享的动效常量。只在这里定缓动与时长，组件里不写魔法数字。
 *
 * 缓动与 CSS token --ease-out-expo 同一条曲线：自信的减速抵达。
 * 时长遵守动效阶梯：120ms 退场 / 150-200ms 反馈 / 250-350ms 布局与浮层。
 * 一律只动 transform 与 opacity —— 长任务不碰 layout 属性，主线程忙时也不掉帧。
 */

/** 与 index.css 的 --ease-out-expo 保持同一条曲线。 */
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

/** 即时反馈：小位移浮现（胶囊、工具卡、按钮浮现）。 */
export const ENTER_FAST: Transition = {
  duration: 0.18,
  ease: EASE_OUT_EXPO,
}

/** 布局级进场：位移稍大（提示条、卡片、面板）。 */
export const ENTER_SOFT: Transition = {
  duration: 0.28,
  ease: EASE_OUT_EXPO,
}

/** 统一退场：比进场快，只淡出。 */
export const EXIT_FAST: Transition = {
  duration: 0.12,
  ease: 'easeIn',
}

/** 常用的进场/退场位姿。 */
export const riseIn = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0 },
}

export const popIn = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.96 },
}
