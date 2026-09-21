import { useEffect, type RefObject } from 'react'
import type { Id, Note } from '@/domain/models'
import {
  publishNoteRanges,
  retractNoteRanges,
  resolveNoteRange,
  supportsNoteHighlight,
  type RegisteredRange,
} from './note-anchor'

/**
 * 把一条消息的笔记画到正文上。
 *
 * 命中区间交给 CSS Custom Highlight API 上色（见 note-anchor.ts），这里只管两件事：
 * 登记，以及**重新登记**。正文的 DOM 会自己变 —— 代码块的高亮是异步渲染的、
 * KaTeX 与图片会在字体加载后重排 —— 变了就得重新定位，否则笔记会停在旧位置或塌掉。
 * 用 MutationObserver 盯着：登记表本身不碰 DOM，所以这条链路不会自激。
 *
 * 浏览器不支持时静默降级：正文上不画线，笔记条照常可读可点。
 */
export function useNoteHighlights(
  bodyRef: RefObject<HTMLElement | null>,
  messageId: Id,
  notes: Note[],
): void {
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !supportsNoteHighlight()) return

    let frame: number | null = null

    const publish = () => {
      frame = null
      const entries: RegisteredRange[] = []
      for (const note of notes) {
        const resolved = resolveNoteRange(note)
        if (resolved) entries.push({ kind: note.kind, range: resolved.range })
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
  }, [bodyRef, messageId, notes])
}
