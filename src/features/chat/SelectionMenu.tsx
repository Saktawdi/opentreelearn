import {
  Check,
  Copy,
  GitBranch,
  Highlighter,
  Loader2,
  MessageCircleQuestion,
  MessageSquareQuote,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Tooltip } from '@/components/ui/tooltip'
import type { Id, NoteLabel, NoteOrigin } from '@/domain/models'
import {
  collectUsedLabels,
  sameAnchor,
  selectionAnchorSpan,
  type SelectionAnchor,
} from '@/domain/notes'
import { cn, errorMessage } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { BranchDialog } from './BranchDialog'
import { NoteDialog } from './NoteDialog'
import { BODY_ATTR, registeredSource, selectionSourceSpan } from './note-anchor'

interface SelectionTarget extends SelectionAnchor {
  messageId: Id
  /**
   * 菜单的铺开中心：框选到的各行里最长那一行的末尾 —— 该行的右边缘，加上行框上下边定出的中线。
   *
   * 「最长的一行」只在选区**终点所在的那个块**里选（见下面的 textBoxes / ownerBlock）：
   * 正文按左缩进排，最长的一行才是这块文字在最右边的边界，把中心放在它末尾，弧顶那一枚正好落在
   * 行右边的留白里；段末落在短尾行上时尤其明显 —— 挂在尾行末尾，弧线中间那几枚会压到上一行的字上。
   */
  endPoint: { x: number; top: number; bottom: number }
}

interface MenuState extends SelectionTarget {
  /** 容器的 left，即月牙盘的中轴（样式里有 -translate-x-1/2） */
  left: number
  /** 容器的 top（顶边，不是中轴） */
  top: number
}

const EDGE = 12

/** selectionchange 到弹菜单的去抖：拖选、拖手柄都是一串连发，等选区停稳再弹。 */
const SHOW_DELAY = 250

/** 触摸点按的位移容差：挪过这个距离算滚动页面，不算点按钮。 */
const TAP_SLOP = 10

/** 夹进 [min, max]；容器比视口还大时 min 会大于 max，取 min 兜底。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * 「月牙盘」排布：圆形图标按钮沿一段**竖直**的弧线铺开 —— 弧顶（中轴）拱在最右，
 * 上下依次向左侧内收，整体是一弯竖起来的月牙。容器尺寸只用于定位与量尺寸。
 */
const BUTTON = 30
const ARC_RADIUS = 68
const ARC_SPREAD = 52
const ARC_WIDTH = Math.round(ARC_RADIUS * (1 - Math.cos((ARC_SPREAD * Math.PI) / 180)) + BUTTON)
const ARC_HEIGHT = Math.round(2 * ARC_RADIUS * Math.sin((ARC_SPREAD * Math.PI) / 180) + BUTTON)

/** 第 index 枚（共 slots 枚）的位置：竖向按正弦铺开，横向按「离弧顶越远越往左收」的正矢排。 */
function slotStyle(index: number, slots: number) {
  const step = (ARC_SPREAD * 2) / Math.max(1, slots - 1)
  const angle = ((-ARC_SPREAD + index * step) * Math.PI) / 180
  return {
    left: Math.round(ARC_WIDTH - BUTTON - ARC_RADIUS * (1 - Math.cos(angle))),
    top: Math.round(ARC_HEIGHT / 2 + ARC_RADIUS * Math.sin(angle) - BUTTON / 2),
  }
}

/**
 * 菜单动作槽位。
 *
 * 学习对话用全部四个；复习中心等新表面按场景裁剪（见各挂载点）——
 * 动作是配置出来的而不是 if 出来的，将来任何新表面都能组合自己的月牙盘。
 */
export type SelectionAction = 'annotate' | 'quote' | 'ask' | 'branch' | 'copy'

const DEFAULT_ACTIONS: readonly SelectionAction[] = ['annotate', 'quote', 'branch', 'copy']

/** 选区锚点所在的消息正文容器；落在输入框、画布等非正文区域时返回 null（不弹菜单）。 */
function ownerBody(node: globalThis.Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  return element?.closest<HTMLElement>(`[${BODY_ATTR}]`) ?? null
}

interface TextBox {
  rect: DOMRect
  node: Text
}

/**
 * 选区覆盖到的文字自己的行框（逐行）。
 *
 * 不能直接用 `range.getClientRects()`：选区整段跨过某个块时，浏览器给的是那个块的**盒模型** ——
 * 段落、标题、列表项都会给一个占满版心的整宽框（高度还可能是一整块）。「最右」一挑就挑到版心
 * 边缘去了，菜单于是飘到消息最右边。把 range 逐文本节点裁一刀再量，得到的才是文字实宽。
 */
function textBoxes(range: Range): TextBox[] {
  const boxes: TextBox[] = []

  const collect = (node: Text) => {
    if (!range.intersectsNode(node)) return
    const length = node.nodeValue?.length ?? 0
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : length
    if (start >= end) return

    const slice = document.createRange()
    slice.setStart(node, start)
    slice.setEnd(node, end)
    for (const rect of slice.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) boxes.push({ rect, node })
    }
  }

  const root = range.commonAncestorContainer
  if (root.nodeType === Node.TEXT_NODE) {
    collect(root as Text)
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) collect(walker.currentNode as Text)
  }

  return boxes
}

/** 块级盒子的 display：用来认出「一个自然段 / 一个列表项」。 */
const BLOCK_DISPLAY = /^(block|list-item|flow-root|table|flex|grid)$/

/** 一段文字所属的那个块（p / li / h2 …），往上找到正文容器为止。 */
function ownerBlock(node: Text, root: HTMLElement): HTMLElement | null {
  let element = node.parentElement
  while (element && element !== root) {
    if (BLOCK_DISPLAY.test(getComputedStyle(element).display)) return element
    element = element.parentElement
  }
  return null
}

/** 取右端最靠右的那个行框：同左缩进的文字里，它也就是最长的那一行。 */
function rightmost(boxes: TextBox[]): TextBox | null {
  let best: TextBox | null = null
  for (const box of boxes) {
    if (best === null || box.rect.left + box.rect.width > best.rect.left + best.rect.width) {
      best = box
    }
  }
  return best
}

function readSelection(): SelectionTarget | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  const body = ownerBody(range.startContainer)
  // 跨气泡的选区没有单一的正文基准，算不出可信的下标 —— 宁可不弹菜单，
  // 也不要记下一条指向错位的笔记。
  if (!body || !body.contains(range.endContainer)) return null

  const messageId = body.getAttribute(BODY_ATTR)
  if (!messageId) return null

  const source = registeredSource(messageId)
  if (source === null) return null

  // 锚点必须在框选当场算：菜单一收、选区一清，就再也还原不出这段文字在正文里的位置了。
  // 换算到的是**源文**下标（公式取整段 `$…$`），不是框选时看到的字形文字 —— 后者
  // 到了 AI 上下文里会变成 `r2=2a2cos2θ` 这种乱码（见 note-anchor.ts）。
  const span = selectionSourceSpan(body, range, source)
  if (!span) return null

  const anchor = selectionAnchorSpan(source, span.start, span.end)
  if (!anchor) return null

  const boxes = textBoxes(range)
  // 只在「选区终点所在的那个块」里挑最长的一行：跨块框选时全局最长的一行常常在别的块里，
  // 而一个长段落的首行本就占满版心 —— 挑中它菜单就飘到版心右缘，离选区十万八千里。
  // 收在终点所在的块里，多行选区仍然挂在块的最右边界外，单块/单行的结果也与全局一致。
  const tail = boxes.at(-1)
  const block = tail ? ownerBlock(tail.node, body) : null
  const scoped = block ? boxes.filter((box) => block.contains(box.node)) : boxes

  // 横向可滚动的块（行间公式、代码块、宽表格都是 overflow-x: auto）里，文字的排版宽度可以远超
  // 可见区，量出来的「最右」落在滚出视野的内容深处 —— 菜单又会飞出消息外。先剔掉伸出版心的行框。
  const bodyRight = body.getBoundingClientRect().right
  const insideBody = scoped.filter((box) => box.rect.left + box.rect.width <= bodyRight + 2)
  // 整段选区都在可滚动块里时没得挑，退回原集合，靠下面的 Math.min 把它拉回版心边缘
  const anchorBox = rightmost(insideBody.length > 0 ? insideBody : scoped)
  if (!anchorBox) return null

  return {
    ...anchor,
    messageId,
    endPoint: {
      x: Math.min(anchorBox.rect.left + anchorBox.rect.width, bodyRight),
      top: anchorBox.rect.top,
      bottom: anchorBox.rect.bottom,
    },
  }
}

function ArcAction({
  icon,
  label,
  index,
  slots,
  busy,
  onSelect,
}: {
  icon: ReactNode
  label: string
  /** 第几枚（0 起）：位置由弧线决定，见 slotStyle */
  index: number
  slots: number
  busy?: boolean
  onSelect: () => void
}) {
  // 触屏点按不能放任合成 mouse 事件：合成 mousedown 会清掉选区，selectionchange
  // 紧跟着把菜单收走，等 click 到达时动作已经拿不到锚点了。于是在 touchend 里
  // 直接触发动作并拦下合成事件；挪过位置的触摸是滚动页面，不触发。
  const touchOrigin = useRef<{ x: number; y: number } | null>(null)
  const touchedAt = useRef(0)

  const handleTouchStart = (event: TouchEvent<HTMLButtonElement>) => {
    const touch = event.touches[0]
    touchOrigin.current = { x: touch.clientX, y: touch.clientY }
  }

  const handleTouchEnd = (event: TouchEvent<HTMLButtonElement>) => {
    const origin = touchOrigin.current
    touchOrigin.current = null
    const touch = event.changedTouches[0]
    if (!origin || !touch) return
    if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > TAP_SLOP) return
    event.preventDefault()
    // 个别内核不遵守「touchend preventDefault 抑制合成 click」的约定，压一下防双发
    touchedAt.current = Date.now()
    if (!busy) onSelect()
  }

  const handleClick = () => {
    if (Date.now() - touchedAt.current < 700) return
    onSelect()
  }

  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        disabled={busy}
        onMouseDown={(event) => event.preventDefault()}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={() => (touchOrigin.current = null)}
        onClick={handleClick}
        style={{ width: BUTTON, height: BUTTON, ...slotStyle(index, slots) }}
        className="absolute grid place-items-center rounded-full border border-line/80 bg-surface/95 text-ink-soft shadow-node ring-1 ring-white/[0.04] backdrop-blur transition-colors hover:border-accent/40 hover:bg-elevated hover:text-accent disabled:opacity-60"
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/**
 * 消息正文框选后的悬浮菜单（月牙盘）：动作槽位由 `actions` 配置 ——
 * 学习对话默认 标注 / 引用到对话 / 新建子分支节点 / 复制；
 * 复习中心传 `['annotate', 'ask', 'copy']` 之类裁剪组合，`noteOrigin` 决定
 * 新建标注的创建面（喂给 AI 的口径不同，见 domain/models 的 NoteOrigin）。
 *
 * 菜单常驻挂载（隐藏态）而不是按需挂载 —— 位置要按自身实际宽高算，先量再定位，
 * 才能在视口边缘正确避让；量尺寸必须在事件里做（不能在 render/effect 里读 DOM）。
 * 定位锚点是框选到的最长那一行的末尾，见 SelectionTarget.endPoint。
 * 弹出的两条路：桌面 mouseup 即时定位；selectionchange 去抖后兜底 —— 触屏没有
 * mouseup（长按选中、拖手柄只发 selectionchange），桌面各家浏览器的时序也不一致。
 * 父组件用 `key={nodeId}` 重挂载，切换节点时状态自然归零。
 */
export function SelectionMenu({
  nodeId,
  onQuote,
  onAsk,
  actions = DEFAULT_ACTIONS,
  noteOrigin = 'chat',
}: {
  nodeId: Id
  /** 引用到对话（'quote' 槽位）：给出才渲染该槽位 */
  onQuote?: (text: string) => void
  /** 就这段追问（'ask' 槽位）：给出才渲染该槽位 */
  onAsk?: (quote: string) => void
  actions?: readonly SelectionAction[]
  /** 新建标注的创建面；缺省 = 学习对话 */
  noteOrigin?: NoteOrigin
}) {
  const { t } = useTranslation('chat')
  const applyAction = useWorkspaceStore((state) => state.applyAction)
  const sendMessage = useWorkspaceStore((state) => state.sendMessage)
  const addNote = useWorkspaceStore((state) => state.addNote)
  const updateNote = useWorkspaceStore((state) => state.updateNote)
  const removeNote = useWorkspaceStore((state) => state.removeNote)

  const menuRef = useRef<HTMLDivElement>(null)
  const copiedTimer = useRef<number | null>(null)
  // 容器（含按钮之间的空隙）上的触摸起点：与 onMouseDown preventDefault 对齐 ——
  // 点在菜单上不丢选区。点在按钮上的触摸由按钮自己拦下（defaultPrevented），这里只兜空隙。
  const containerTouch = useRef<{ x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // 标注弹窗的状态：框选一进弹窗就没了，所以锚点在这里连同原文一起被捕获下来。
  // 一段文字至多一条标注（高亮就是「不带标签的标注」），已有则进入编辑、没有则新建。
  const [annotating, setAnnotating] = useState<{
    anchor: SelectionAnchor & { messageId: Id }
    noteId?: Id
    labels?: NoteLabel[]
    body?: string
  } | null>(null)
  // 新建子节点小窗的状态：同样要在菜单收起前把选区捕获下来。
  const [branching, setBranching] = useState<{ quote: string; messageId: Id } | null>(null)

  useEffect(() => {
    let showTimer: number | null = null

    const place = () => {
      const element = menuRef.current
      const target = readSelection()
      // 选区滚出视口（例如切换节点后重排）就别再弹了，菜单是贴着文字出现的
      const onScreen =
        target !== null &&
        target.endPoint.bottom > 0 &&
        target.endPoint.top < window.innerHeight
      if (!target || !element || !onScreen) {
        setMenu(null)
        return
      }

      const width = element.offsetWidth
      const height = element.offsetHeight

      // 月牙盘以「最长那一行的末尾」为中心铺开：中轴落在文字块的最右边界，中腰对准那一行。
      // 视口边缘只做整体平移避让，不改锚点与菜单的相对关系。
      setMenu({
        ...target,
        left: clamp(
          target.endPoint.x,
          EDGE + width / 2,
          window.innerWidth - EDGE - width / 2,
        ),
        top: clamp(
          (target.endPoint.top + target.endPoint.bottom) / 2 - height / 2,
          EDGE,
          window.innerHeight - EDGE - height,
        ),
      })
    }

    const dismiss = () => setMenu(null)

    const handleMouseUp = (event: MouseEvent) => {
      // 点在菜单自己身上不算「重新选区」，否则按钮的 mousedown 会先把菜单关掉
      if (menuRef.current?.contains(event.target as globalThis.Node)) return
      place()
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      // Esc 收起后选区还在，Esc 自己的 keyup 会把刚关掉的菜单再弹回来 —— 只跳过这一枚
      if (event.key === 'Escape') return
      place()
    }

    // 选区变化是弹出与否的事实源：桌面拖选的时序各家浏览器不一致（Safari 双击选词
    // 落在 mouseup 之后、窗口外松开收不到 mouseup），触屏更是压根没有 mouseup ——
    // 长按选中、拖手柄只会发 selectionchange。折叠立即收起；非折叠去抖后弹出/重定位，
    // 连发的中间态靠去抖跳过。桌面 mouseup 保留为即时路径，手感不变。
    const handleSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        if (showTimer !== null) {
          window.clearTimeout(showTimer)
          showTimer = null
        }
        setMenu(null)
        return
      }
      if (showTimer !== null) window.clearTimeout(showTimer)
      showTimer = window.setTimeout(() => {
        showTimer = null
        place()
      }, SHOW_DELAY)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keyup', handleKeyUp)
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)

    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keyup', handleKeyUp)
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      if (showTimer !== null) window.clearTimeout(showTimer)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    }
  }, [])

  /** 收起菜单并清掉页面选区：动作已经落到数据上，残留的选区只会让菜单再次弹出来。 */
  const close = () => {
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  /**
   * 新建子节点的落地动作：建节点，把框选的原文收进引用胶囊（quote part），
   * 指令作为正文（text part），两条一起发出去 —— 与输入框「先引用，后提问」的结构一致。
   * remember=true 时把这条指令写进偏好，下次点击图标不再弹窗、直接发送。
   */
  const runBranch = async (target: { quote: string; messageId: Id }, prompt: string, remember: boolean) => {
    setBusy(true)
    try {
      if (remember) {
        await useSettingsStore.getState().patch({
          branchPrompt: { showDialog: false, rememberedPrompt: prompt },
        })
        toast.success(t('selection.remembered'))
      }
      // 分支节点：落在当前节点下方，并从选中文字所在的那条消息处继承上下文
      const node = await applyAction('branch', nodeId, target.messageId)
      if (!node) throw new Error(t('selection.createNodeFailed'))
      setBranching(null)
      await sendMessage(node.id, [
        { type: 'quote', text: target.quote },
        { type: 'text', text: prompt },
      ])
    } catch (error) {
      toast.error(t('selection.branchFailed', { error: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  /** 图标入口：偏好是「不再弹窗」且有记住的指令就直发，否则弹小窗让用户选。 */
  const openBranch = () => {
    if (!menu || busy) return
    const target = { quote: menu.quote, messageId: menu.messageId }
    const preference = useSettingsStore.getState().settings.branchPrompt
    const remembered = preference.showDialog ? null : preference.rememberedPrompt
    close()
    if (remembered) {
      void runBranch(target, remembered, false)
      return
    }
    setBranching(target)
  }

  /**
   * 标注（高亮与打标签合二为一）：同一段文字至多一条标注。
   * 已有标注（无论带不带标签）就打开它继续改；没有则新建，弹窗里不选标签直接保存就是纯高亮书签。
   */
  const openAnnotate = () => {
    if (!menu || busy) return
    const target = menu
    const existing = (
      useWorkspaceStore.getState().notesByMessage[target.messageId] ?? []
    ).find((note) => sameAnchor(note, target))

    setAnnotating({
      anchor: {
        messageId: target.messageId,
        quote: target.quote,
        start: target.start,
        end: target.end,
      },
      noteId: existing?.id,
      labels: existing?.labels,
      body: existing?.body,
    })
    close()
  }

  const saveAnnotation = async (input: { labels: NoteLabel[]; body?: string }) => {
    if (!annotating) return
    try {
      if (annotating.noteId) {
        await updateNote(annotating.noteId, {
          labels: input.labels,
          ...(input.body !== undefined ? { body: input.body } : {}),
        })
      } else {
        const created = await addNote({
          nodeId,
          messageId: annotating.anchor.messageId,
          labels: input.labels,
          quote: annotating.anchor.quote,
          start: annotating.anchor.start,
          end: annotating.anchor.end,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(noteOrigin !== 'chat' ? { origin: noteOrigin } : {}),
        })
        if (!created) throw new Error(t('selection.noteWriteFailed'))
      }
      setAnnotating(null)
    } catch (error) {
      toast.error(t('note.toastSaveFailed', { error: errorMessage(error) }))
    }
  }

  const deleteAnnotation = async (id: Id) => {
    try {
      await removeNote(id)
    } catch (error) {
      toast.error(t('note.toastDeleteFailed', { error: errorMessage(error) }))
    } finally {
      setAnnotating(null)
    }
  }

  const annotatingNoteId = annotating?.noteId ?? null

  const quoteToComposer = () => {
    if (!menu || !onQuote) return
    onQuote(menu.quote)
    // 交棒给输入框：清掉页面选区，否则接下来打字时菜单会被 keyup 重新唤起
    close()
  }

  const askAboutSelection = () => {
    if (!menu || !onAsk) return
    const quote = menu.quote
    close()
    onAsk(quote)
  }

  const copy = async () => {
    if (!menu) return
    try {
      await navigator.clipboard.writeText(menu.quote)
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      toast.error(t('selection.copyFailed'))
    }
  }

  // 没给 handler 的动作槽位不渲染（quote/ask 是可选能力，branch/copy/annotate 恒可用）
  const slots = actions.filter(
    (action) => (action !== 'quote' || Boolean(onQuote)) && (action !== 'ask' || Boolean(onAsk)),
  )

  const renderAction = (action: SelectionAction, index: number) => {
    switch (action) {
      case 'annotate':
        return (
          <ArcAction
            key={action}
            index={index}
            slots={slots.length}
            icon={<Highlighter className="h-4 w-4" />}
            label={t('selection.annotate')}
            busy={busy}
            onSelect={openAnnotate}
          />
        )
      case 'quote':
        return (
          <ArcAction
            key={action}
            index={index}
            slots={slots.length}
            icon={<MessageSquareQuote className="h-4 w-4" />}
            label={t('selection.quote')}
            onSelect={quoteToComposer}
          />
        )
      case 'ask':
        return (
          <ArcAction
            key={action}
            index={index}
            slots={slots.length}
            icon={<MessageCircleQuestion className="h-4 w-4" />}
            label={t('selection.ask')}
            onSelect={askAboutSelection}
          />
        )
      case 'branch':
        return (
          <ArcAction
            key={action}
            index={index}
            slots={slots.length}
            icon={
              busy ? (
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
              ) : (
                <GitBranch className="h-4 w-4" />
              )
            }
            label={t('selection.branchNode')}
            busy={busy}
            onSelect={openBranch}
          />
        )
      case 'copy':
        return (
          <ArcAction
            key={action}
            index={index}
            slots={slots.length}
            icon={copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            label={copied ? t('selection.copied') : t('selection.copy')}
            onSelect={() => void copy()}
          />
        )
    }
  }

  return (
    <>
      <div
        // 隐藏态常驻用于量尺寸；key 变化让每次弹出重放 pop-in 动画
        key={menu ? 'open' : 'idle'}
        ref={menuRef}
        style={{
          width: ARC_WIDTH,
          height: ARC_HEIGHT,
          ...(menu ? { left: menu.left, top: menu.top } : {}),
        }}
        onMouseDown={(event) => event.preventDefault()}
        onTouchStart={(event) => {
          const touch = event.touches[0]
          containerTouch.current = { x: touch.clientX, y: touch.clientY }
        }}
        onTouchEnd={(event) => {
          const origin = containerTouch.current
          containerTouch.current = null
          const touch = event.changedTouches[0]
          if (!origin || !touch) return
          if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > TAP_SLOP) return
          if (event.defaultPrevented) return
          event.preventDefault()
        }}
        className={cn(
          'menu-pop fixed z-50 -translate-x-1/2',
          menu ? '' : 'invisible pointer-events-none',
        )}
      >
        {slots.map(renderAction)}
      </div>

      {branching ? (
        <BranchDialog
          key={branching.messageId}
          quote={branching.quote}
          busy={busy}
          rememberedPrompt={useSettingsStore.getState().settings.branchPrompt.rememberedPrompt}
          onCancel={() => setBranching(null)}
          onConfirm={(prompt, remember) => void runBranch(branching, prompt, remember)}
        />
      ) : null}

      {annotating ? (
        <NoteDialog
          key={annotating.noteId ?? `${annotating.anchor.messageId}:${annotating.anchor.start}`}
          quote={annotating.anchor.quote}
          labels={annotating.labels}
          body={annotating.body}
          suggestions={collectUsedLabels(
            Object.values(useWorkspaceStore.getState().notesByMessage).flat(),
          )}
          onCancel={() => setAnnotating(null)}
          onSubmit={saveAnnotation}
          onDelete={annotatingNoteId ? () => void deleteAnnotation(annotatingNoteId) : undefined}
        />
      ) : null}
    </>
  )
}
