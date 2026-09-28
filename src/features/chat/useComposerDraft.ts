import { useCallback, useEffect, useRef, useState } from 'react'
import { getRepositories } from '@/data'
import { isEmptyDraft, type ComposerDraft } from '@/domain/composer/draft'
import type { Asset, Id } from '@/domain/models'
import { createImageAsset } from '@/services/images'

export interface PendingImage {
  asset: Asset
  url: string
}

/**
 * 打字不该每个键都写一次 IndexedDB；但「切走页面」这个动作随时可能发生，
 * 防抖窗口内的内容必须能在卸载时补上，否则我们要修的 bug 会换个形式复现。
 */
const SAVE_DELAY = 400

interface DraftState {
  text: string
  quotes: string[]
  pending: PendingImage[]
}

/** 视图状态带上 nodeId：换节点时靠它判断「当前这份草稿属于谁」。 */
interface DraftView {
  nodeId: Id
  loading: boolean
  draft: DraftState
}

function emptyDraft(): DraftState {
  return { text: '', quotes: [], pending: [] }
}

/**
 * 造预览用的 objectURL。返回 null 表示这张图恢复不了 —— 归一化已经挡掉了坏 blob，
 * 这里再兜一层：一张图的意外不该让用户连打好的正文一起丢掉。
 */
function toPendingImage(asset: Asset): PendingImage | null {
  try {
    return { asset, url: URL.createObjectURL(asset.blob) }
  } catch {
    return null
  }
}

function toPendingImages(assets: Asset[]): PendingImage[] {
  const restored: PendingImage[] = []
  for (const asset of assets) {
    const image = toPendingImage(asset)
    if (image) restored.push(image)
  }
  return restored
}

function revokeAll(images: PendingImage[]): void {
  for (const item of images) URL.revokeObjectURL(item.url)
}

/** 落盘失败不该打断输入：草稿是便利功能，不是数据的唯一副本。 */
function swallow(promise: Promise<unknown>): void {
  void promise.catch(() => undefined)
}

/**
 * 对话输入框的草稿：一个节点一份，落在本机 IndexedDB（按账号分库，天然不串号）。
 *
 * 三条要守住的规则：
 *
 * 1. **读是 await 的**。读取期间 `loading` 为真、输入区不渲染 —— 否则用户刚打下的
 *    字会被随后到达的草稿覆盖掉。
 * 2. **写是防抖的，但卸载必落盘**。节点切换与组件卸载都会把窗口内剩余内容补写，
 *    这是「切走再回来还在」这个需求真正成立的地方。
 * 3. **按 nodeId 归档**。画布里切换节点时组件并不卸载（`CanvasPage` 没有给
 *    `FocusChatView` 加 key），草稿跟着 nodeId 走，顺带堵住了旧实现里
 *    「A 节点的草稿流到 B 节点」的问题。
 */
export function useComposerDraft(nodeId: Id, projectId: Id) {
  const [view, setView] = useState<DraftView>(() => ({
    nodeId,
    loading: true,
    draft: emptyDraft(),
  }))

  // 换节点时在**渲染期**就换掉整份草稿。等 effect 跑完再清，新节点会先闪一下
  // 上一个节点的内容 —— 那正是我们要修的串台，只是换了个时间窗出现。
  if (view.nodeId !== nodeId) {
    setView({ nodeId, loading: true, draft: emptyDraft() })
  }
  const { loading, draft } = view

  // 定时器与卸载兜底只能看到「此刻」的内容，不能闭包捕获旧值
  const draftRef = useRef<DraftState>(emptyDraft())
  const timerRef = useRef<number | null>(null)
  // 异步读取的世代号：快速切换节点时，只有最后一次读取的结果算数
  const generationRef = useRef(0)
  const nodeIdRef = useRef(nodeId)
  const projectIdRef = useRef(projectId)
  // 世代号挡得住「切节点」，挡不住「整个组件卸载」——卸载时 async 回调照样会跑，
  // 那时创建的 objectURL 没有任何人回收，泄漏就发生在这里。
  // effect 体里必须重新置 true：StrictMode 下 effect 会「挂载→清理→再挂载」，
  // 只在清理里置 false 的话，开发环境下这个标记会永久停在 false，草稿永远读不回来。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const persist = useCallback((targetNodeId: Id) => {
    const current = draftRef.current
    const assets = current.pending.map((item) => item.asset)
    const drafts = getRepositories().composerDrafts
    // 空草稿不落盘，直接删掉 —— 否则表里会堆满没有任何内容的空壳记录
    if (isEmptyDraft({ text: current.text, quotes: current.quotes, assets })) {
      swallow(drafts.remove(targetNodeId))
      return
    }
    const saved: ComposerDraft = {
      id: targetNodeId,
      projectId: projectIdRef.current,
      nodeId: targetNodeId,
      text: current.text,
      quotes: current.quotes,
      assets,
      updatedAt: Date.now(),
    }
    swallow(drafts.save(saved))
  }, [])

  const cancelPendingSave = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  /** delay 为 0 表示立刻落盘（图片变动这类低频事件，不值得等）。 */
  const scheduleSave = useCallback(
    (delay: number) => {
      cancelPendingSave()
      if (delay <= 0) {
        persist(nodeIdRef.current)
        return
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        persist(nodeIdRef.current)
      }, delay)
    },
    [cancelPendingSave, persist],
  )

  useEffect(() => {
    const previousNodeId = nodeIdRef.current
    // 离开上一个节点：先把窗口里没落盘的内容补上，再去读新节点的
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
      persist(previousNodeId)
    }
    nodeIdRef.current = nodeId
    projectIdRef.current = projectId

    const generation = generationRef.current + 1
    generationRef.current = generation
    // 渲染期已经把 view 换掉了，这里只需同步引用并释放上一份的 objectURL
    revokeAll(draftRef.current.pending)
    draftRef.current = emptyDraft()

    const settle = (draft: DraftState) => {
      draftRef.current = draft
      setView({ nodeId, loading: false, draft })
    }

    swallow(
      getRepositories()
        .composerDrafts.get(nodeId)
        .then((saved) => {
          if (!aliveRef.current || generation !== generationRef.current) return
          settle(
            saved
              ? { text: saved.text, quotes: saved.quotes, pending: toPendingImages(saved.assets) }
              : emptyDraft(),
          )
        })
        .catch(() => {
          // 读取失败必须照样把加载态收掉：漏了这一句，输入框会永远停在骨架屏上。
          // 草稿是便利功能，读不出来就当没存过，绝不能因此挡住用户输入。
          if (!aliveRef.current || generation !== generationRef.current) return
          settle(emptyDraft())
        }),
    )
    return undefined
  }, [nodeId, projectId, persist])

  // 卸载兜底：把防抖窗口里剩下的内容落盘，再释放 objectURL（内容在 blob 里，不受影响）
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
        persist(nodeIdRef.current)
      }
      revokeAll(draftRef.current.pending)
    },
    [persist],
  )

  const apply = useCallback((next: DraftState, delay: number) => {
    draftRef.current = next
    setView((previous) => ({ ...previous, draft: next }))
    scheduleSave(delay)
  }, [scheduleSave])

  const setText = useCallback(
    (value: string) => {
      apply({ ...draftRef.current, text: value }, SAVE_DELAY)
    },
    [apply],
  )

  const addQuote = useCallback(
    (value: string) => {
      const clean = value.trim()
      if (!clean) return
      const current = draftRef.current.quotes
      if (current.includes(clean)) return
      apply({ ...draftRef.current, quotes: [...current, clean] }, SAVE_DELAY)
    },
    [apply],
  )

  const removeQuote = useCallback(
    (value: string) => {
      apply(
        { ...draftRef.current, quotes: draftRef.current.quotes.filter((quote) => quote !== value) },
        SAVE_DELAY,
      )
    },
    [apply],
  )

  const attachFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const generation = generationRef.current
      const project = projectIdRef.current
      const created = await Promise.all(
        files.map(async (file) => toPendingImage(await createImageAsset(file, project))),
      )
      const attached = created.filter((item): item is PendingImage => item !== null)
      // 压缩要跑 canvas，是异步的：这期间可能已经切到别的节点，甚至整个组件已卸载，
      // 迟到的结果一律不并进去，URL 就地释放
      if (!aliveRef.current || generation !== generationRef.current) {
        revokeAll(attached)
        return
      }
      apply({ ...draftRef.current, pending: [...draftRef.current.pending, ...attached] }, 0)
    },
    [apply],
  )

  const removePending = useCallback(
    (assetId: Id) => {
      const target = draftRef.current.pending.find((item) => item.asset.id === assetId)
      if (target) URL.revokeObjectURL(target.url)
      apply(
        { ...draftRef.current, pending: draftRef.current.pending.filter((item) => item.asset.id !== assetId) },
        0,
      )
    },
    [apply],
  )

  /** 发送成功后清空：输入框归零的同时，草稿记录一并删掉。 */
  const clear = useCallback(() => {
    cancelPendingSave()
    revokeAll(draftRef.current.pending)
    draftRef.current = emptyDraft()
    setView({ nodeId: nodeIdRef.current, loading: false, draft: emptyDraft() })
    swallow(getRepositories().composerDrafts.remove(nodeIdRef.current))
  }, [cancelPendingSave])

  return {
    loading,
    text: draft.text,
    setText,
    quotes: draft.quotes,
    addQuote,
    removeQuote,
    pending: draft.pending,
    attachFiles,
    removePending,
    clear,
  }
}
