import { useEffect, type RefObject } from 'react'
import type { Id, Note } from '@/domain/models'
import {
  publishNoteRanges,
  registerMessageSource,
  releaseMessageSource,
  resolveNoteRange,
  retractNoteRanges,
  supportsNoteHighlight,
  type RegisteredRange,
} from './note-anchor'

/**
 * 把一条消息的笔记画到正文上，**并把源文登记给锚点换算用**。
 *
 * 命中区间交给 CSS Custom Highlight API 上色（见 note-anchor.ts），这里管三件事：
 * 登记源文、登记高亮区间，以及**重新登记**。正文的 DOM 会自己变 —— 代码块的高亮是
 * 异步渲染的、KaTeX 与图片会在字体加载后重排 —— 变了就得重新定位，否则笔记会停在
 * 旧位置或塌掉。用 MutationObserver 盯着：登记表本身不碰 DOM，所以这条链路不会自激。
 *
 * 源文在这里登记而不是渲染期：框选与高亮都要它，晚一步就白跑一轮；卸载时一并清掉，
 * 切节点不会留下别的消息的源文。浏览器不支持高亮时**仍要登记源文** ——
 * 框选菜单与写工具都靠它把选区换回原文坐标。
 */
export function useNoteHighlights(
  bodyRef: RefObject<HTMLElement | null>,
  messageId: Id,
  notes: Note[],
  source: string,
): void {
  useEffect(() => {
    registerMessageSource(messageId, source)
    return () => releaseMessageSource(messageId)
  }, [messageId, source])

  useEffect(() => {
    const body = bodyRef.current
    if (!body || !supportsNoteHighlight()) return

    let frame: number | null = null

    const publish = () => {
      frame = null
      const entries: RegisteredRange[] = []
      for (const note of notes) {
        const resolved = resolveNoteRange(note)
        if (resolved) entries.push({ labeled: note.labels.length > 0, range: resolved.range })
      }
      publishNoteRanges(messageId, entries)
    }

    const schedule = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(publish)
    }

    publish()
    const observer = new MutationObserver(schedule)
    observer.observe(body, { childList: true, subtree: true, characterData: true })

    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
      retractNoteRanges(messageId)
    }
  }, [bodyRef, messageId, notes, source])
}
