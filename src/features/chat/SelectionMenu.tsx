import {
  Check,
  Copy,
  GitBranch,
  Highlighter,
  Loader2,
  MessageSquareQuote,
  MessageSquareText,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Tooltip } from '@/components/ui/tooltip'
import type { Id } from '@/domain/models'
import { sameAnchor, selectionAnchor, type SelectionAnchor } from '@/domain/notes'
import { cn, errorMessage } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { NoteDialog } from './NoteDialog'
import { BODY_ATTR, offsetInBody } from './note-anchor'

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

/** 夹进 [min, max]；容器比视口还大时 min 会大于 max，取 min 兜底。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * 「月牙盘」排布：五枚圆形图标按钮沿一段**竖直**的弧线铺开 —— 弧顶（中轴那一枚）拱在最右，
 * 上下两枚依次向左侧内收，整体是一弯竖起来的月牙。容器尺寸只用于定位与量尺寸。
 *
 * 半径与张角由「相邻两枚不能叠在一起」定：相邻圆心距 `2R·sin(步长/2)` 要大于按钮直径。
 */
const BUTTON = 30
const ARC_RADIUS = 68
const ARC_SPREAD = 62
const SLOTS = 5
const ARC_STEP = (ARC_SPREAD * 2) / (SLOTS - 1)
const ARC_WIDTH = Math.round(ARC_RADIUS * (1 - Math.cos((ARC_SPREAD * Math.PI) / 180)) + BUTTON)
const ARC_HEIGHT = Math.round(2 * ARC_RADIUS * Math.sin((ARC_SPREAD * Math.PI) / 180) + BUTTON)

/** 第 index 枚的位置：竖向按正弦铺开，横向按「离弧顶越远越往左收」的正矢排。 */
function slotStyle(index: number) {
  const angle = ((-ARC_SPREAD + index * ARC_STEP) * Math.PI) / 180
  return {
    left: Math.round(ARC_WIDTH - BUTTON - ARC_RADIUS * (1 - Math.cos(angle))),
    top: Math.round(ARC_HEIGHT / 2 + ARC_RADIUS * Math.sin(angle) - BUTTON / 2),
  }
}

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

  const raw = selection.toString()
  if (!raw.trim()) return null

  const range = selection.getRangeAt(0)
  const body = ownerBody(range.startContainer)
  // 跨气泡的选区没有单一的正文基准，算不出可信的下标 —— 宁可不弹菜单，
  // 也不要记下一条指向错位的笔记。
  if (!body || !body.contains(range.endContainer)) return null

  const messageId = body.getAttribute(BODY_ATTR)
  if (!messageId) return null

  // 锚点必须在框选当场算：菜单一收、选区一清，就再也还原不出这段文字在正文里的位置了
  const anchor = selectionAnchor(
    raw,
    offsetInBody(body, range.startContainer, range.startOffset),
  )
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
  busy,
  onSelect,
}: {
  icon: ReactNode
  label: string
  /** 第几枚（0 起）：位置由弧线决定，见 slotStyle */
  index: number
  busy?: boolean
  onSelect: () => void
}) {
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        disabled={busy}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSelect}
        style={{ width: BUTTON, height: BUTTON, ...slotStyle(index) }}
        className="absolute grid place-items-center rounded-full border border-line/80 bg-surface/95 text-ink-soft shadow-node ring-1 ring-white/[0.04] backdrop-blur transition-colors hover:border-accent/40 hover:bg-elevated hover:text-accent disabled:opacity-60"
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/**
 * 消息正文框选后的悬浮菜单（月牙盘）：五枚圆形图标按钮沿竖直弧线 ——
 * 高亮笔记 / 注释笔记 / 引用到对话 / 新建子分支节点 / 复制。
 *
 * 菜单常驻挂载（隐藏态）而不是按需挂载 —— 位置要按自身实际宽高算，先量再定位，
 * 才能在视口边缘正确避让；量尺寸必须在事件里做（不能在 render/effect 里读 DOM）。
 * 定位锚点是框选到的最长那一行的末尾，见 SelectionTarget.endPoint。
 * 父组件用 `key={nodeId}` 重挂载，切换节点时状态自然归零。
 */
export function SelectionMenu({
  nodeId,
  onQuote,
}: {
  nodeId: Id
  onQuote: (text: string) => void
}) {
  const applyAction = useWorkspaceStore((state) => state.applyAction)
  const sendMessage = useWorkspaceStore((state) => state.sendMessage)
  const addNote = useWorkspaceStore((state) => state.addNote)
  const updateNote = useWorkspaceStore((state) => state.updateNote)
  const removeNote = useWorkspaceStore((state) => state.removeNote)

  const menuRef = useRef<HTMLDivElement>(null)
  const copiedTimer = useRef<number | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // 注释的输入框：框选一进弹窗就没了，所以锚点在这里连同原文一起被捕获下来
  const [annotating, setAnnotating] = useState<{
    anchor: SelectionAnchor & { messageId: Id }
    noteId?: Id
    body?: string
  } | null>(null)

  useEffect(() => {
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

    const handleSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keyup', place)
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)

    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keyup', place)
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    }
  }, [])

  /** 收起菜单并清掉页面选区：动作已经落到数据上，残留的选区只会让菜单再次弹出来。 */
  const close = () => {
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  const createBranch = async () => {
    if (!menu || busy) return
    setBusy(true)
    try {
      // 分支节点：落在当前节点下方，并从选中文字所在的那条消息处继承上下文
      const node = await applyAction('branch', nodeId, menu.messageId)
      if (!node) throw new Error('未能创建节点')
      setMenu(null)
      await sendMessage(node.id, [{ type: 'text', text: menu.quote }])
    } catch (error) {
      toast.error(`新建分支失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 高亮笔记：同一段文字再点一次就是取消 —— 高亮是开关语义，堆两条一模一样的高亮
   * 除了让正文颜色更深没有任何意义。
   */
  const toggleHighlight = async () => {
    if (!menu || busy) return
    const target = menu
    const existing = (
      useWorkspaceStore.getState().notesByMessage[target.messageId] ?? []
    ).find((note) => note.kind === 'highlight' && sameAnchor(note, target))

    setBusy(true)
    try {
      if (existing) {
        await removeNote(existing.id)
        toast.success('已取消高亮')
      } else {
        const created = await addNote({
          nodeId,
          messageId: target.messageId,
          kind: 'highlight',
          quote: target.quote,
          start: target.start,
          end: target.end,
        })
        if (!created) throw new Error('未能写入笔记')
      }
      close()
    } catch (error) {
      toast.error(`高亮失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 注释笔记：这一段已经有注释就直接打开它继续改，不再叠第二条。 */
  const annotate = () => {
    if (!menu || busy) return
    const target = menu
    const existing = (
      useWorkspaceStore.getState().notesByMessage[target.messageId] ?? []
    ).find((note) => note.kind === 'annotation' && sameAnchor(note, target))

    setAnnotating({
      anchor: {
        messageId: target.messageId,
        quote: target.quote,
        start: target.start,
        end: target.end,
      },
      noteId: existing?.id,
      body: existing?.body,
    })
    close()
  }

  const saveAnnotation = async (body: string) => {
    if (!annotating) return
    try {
      if (annotating.noteId) {
        await updateNote(annotating.noteId, { body })
      } else {
        const created = await addNote({
          nodeId,
          messageId: annotating.anchor.messageId,
          kind: 'annotation',
          quote: annotating.anchor.quote,
          start: annotating.anchor.start,
          end: annotating.anchor.end,
          body,
        })
        if (!created) throw new Error('未能写入笔记')
      }
      setAnnotating(null)
    } catch (error) {
      toast.error(`保存注释失败：${errorMessage(error)}`)
    }
  }

  const deleteAnnotation = async (id: Id) => {
    try {
      await removeNote(id)
    } catch (error) {
      toast.error(`删除注释失败：${errorMessage(error)}`)
    } finally {
      setAnnotating(null)
    }
  }

  const annotationNoteId = annotating?.noteId ?? null

  const quoteToComposer = () => {
    if (!menu) return
    onQuote(menu.quote)
    // 交棒给输入框：清掉页面选区，否则接下来打字时菜单会被 keyup 重新唤起
    close()
  }

  const copy = async () => {
    if (!menu) return
    try {
      await navigator.clipboard.writeText(menu.quote)
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      toast.error('复制失败，请手动复制')
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
        className={cn(
          'menu-pop fixed z-50 -translate-x-1/2',
          menu ? '' : 'invisible pointer-events-none',
        )}
      >
        <ArcAction
          index={0}
          icon={<Highlighter className="h-4 w-4" />}
          label="高亮笔记"
          busy={busy}
          onSelect={() => void toggleHighlight()}
        />
        <ArcAction
          index={1}
          icon={<MessageSquareText className="h-4 w-4" />}
          label="注释笔记"
          busy={busy}
          onSelect={annotate}
        />
        <ArcAction index={2} icon={<MessageSquareQuote className="h-4 w-4" />} label="引用到对话" onSelect={quoteToComposer} />
        <ArcAction
          index={3}
          icon={
            busy ? (
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
            ) : (
              <GitBranch className="h-4 w-4" />
            )
          }
          label="新建子分支节点"
          busy={busy}
          onSelect={() => void createBranch()}
        />
        <ArcAction
          index={4}
          icon={copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          label={copied ? '已复制' : '复制'}
          onSelect={() => void copy()}
        />
      </div>

      {annotating ? (
        <NoteDialog
          key={annotating.noteId ?? `${annotating.anchor.messageId}:${annotating.anchor.start}`}
          kind="annotation"
          quote={annotating.anchor.quote}
          body={annotating.body}
          onCancel={() => setAnnotating(null)}
          onSubmit={saveAnnotation}
          onDelete={
            annotationNoteId ? () => void deleteAnnotation(annotationNoteId) : undefined
          }
        />
      ) : null}
    </>
  )
}
