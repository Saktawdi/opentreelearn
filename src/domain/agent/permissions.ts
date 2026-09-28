import type { ParseKeys } from 'i18next'
import type { Id, Node } from '@/domain/models'

/**
 * 工具授权的**唯一真相源**：每个工具是什么性质、要不要问用户、卡片怎么描述这次调用。
 *
 * 为什么判定放在 domain 而不是在 store 或 UI：
 * 「建节点要问、查同项目不要问」是**业务口径**，与 AI SDK、与界面都无关。放这里
 * 才能直接被单测覆盖，改一条规则不必起界面。store 只负责「阻塞与结算」，
 * 工具注册表只负责「包一层」，界面只负责「按描述渲染」——三层各管一件事。
 *
 * 三条纪律：
 * 1. **写必问**。任何改动用户数据的工具，调用前一律征询，不看偏好之外的东西。
 * 2. **读看区域**。读工具在开放区域内直接放行；只有主动取开放区（当前项目）
 *    之外的数据才问。项目内的跨节点检索是本产品的主力场景，按节点设卡会把它废掉。
 * 3. **没登记就问**（fail-closed）。以后新加工具忘了登记，会被拦下来问用户，
 *    而不是静默放行——权限代码的默认方向必须是「关」。
 */

/** 工具性质：读工具不改数据，写工具会动用户的东西。 */
export type ToolKind = 'read' | 'write'

/** 项目级授权偏好（对应输入框工具栏的那一个胶囊）。 */
export type ToolPermissionMode = 'prompt' | 'always_allow'

/** 用户对一次授权请求的裁决。 */
export type ToolPermissionDecision = 'allow' | 'deny'

/**
 * 开放区判定结果。
 *
 * `unresolved` 是刻意分出来的一档：目标 id 在当前项目里根本解析不到（不存在 /
 * 已删除 / 属别的项目）。这种情况该让工具照常报「节点不存在」，而不是弹一张
 * 「要不要授权我读一个不存在的东西」的卡给用户。
 */
export type ZoneVerdict =
  | { zone: 'open' }
  | { zone: 'outside' }
  | { zone: 'unresolved' }

const OPEN: ZoneVerdict = { zone: 'open' }
const UNRESOLVED: ZoneVerdict = { zone: 'unresolved' }

/** 一次插值参数集。 */
export type ApprovalParams = Record<string, string | number>

/** 一条走 i18n 键的文案：键受 `ParseKeys` 约束，写错键编译期就报错。 */
export interface ApprovalText {
  key: ParseKeys<'chat'>
  params?: ApprovalParams
}

/**
 * 授权卡要展示的全部内容：一句标题 + 若干「字段: 值」行 + 模型给的可选理由。
 *
 * 这里只出**键**，不出译文：模块加载时还没有语言可用，界面渲染时才解析
 * （与 ToolActivities 存键不存译文的同一口径）。
 */
export interface ToolApprovalPrompt {
  title: ApprovalText
  rows: Array<{ label: ApprovalText; value: ApprovalText }>
  reason?: string
}

/** 闸门判定需要的运行时上下文。 */
export interface GateContext {
  /** 当前正在对话的节点：写工具的缺省目标，也是「这里 / 当前」的所指 */
  currentNodeId?: Id
  /** 在当前项目里按 id 找节点；解析不到（不存在 / 属别的项目）返回 null */
  findNode: (nodeId: Id) => { id: Id; title: string } | null
  /**
   * 开放区判定：目标是否落在开放区域内。
   *
   * **跨项目检索落地时，这是全系统唯一需要改的判定点。** 闸门、队列、卡片、
   * 偏好、提示词都不用动。当前实现是「节点属于当前项目」，而快照本身就是当前
   * 项目的全量，所以对现有只读工具恒为放行——这是数据层的现状，不是判定没接。
   */
  withinOpenZone: (nodeId: Id) => boolean
  /** 项目级授权偏好 */
  permission: ToolPermissionMode
}

interface ToolGuard {
  kind: ToolKind
  /**
   * 读工具专用：这次读取的目标是否越出开放区。
   * 缺省表示「构造上不可能越界」（如树大纲、标签统计——它们只遍历本项目快照）。
   */
  scope?: (input: Record<string, unknown>, ctx: GateContext) => ZoneVerdict
  /** 授权卡怎么描述这次调用。 */
  describe: (
    input: Record<string, unknown>,
    ctx: GateContext,
    zone: ZoneVerdict,
  ) => ToolApprovalPrompt
}

export type ToolApprovalVerdict =
  | { action: 'allow' }
  | { action: 'ask'; prompt: ToolApprovalPrompt }

/** 取工具入参：模型给的东西类型不可信，统一按「可能没有」读。 */
function arg(input: Record<string, unknown>, key: string): unknown {
  return input[key]
}

function argString(input: Record<string, unknown>, key: string): string {
  const value = arg(input, key)
  return typeof value === 'string' ? value : ''
}

function argStrings(input: Record<string, unknown>, key: string): string[] {
  const value = arg(input, key)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 写工具的缺省目标：不传 id 就是「当前节点」。 */
function targetNodeId(input: Record<string, unknown>, ctx: GateContext): Id | undefined {
  return argString(input, 'nodeId') || ctx.currentNodeId
}

/** 「目标节点」行：目标解析得到就写标题，解析不到就标出节点 id。 */
function nodeRow(
  input: Record<string, unknown>,
  ctx: GateContext,
): { label: ApprovalText; value: ApprovalText } {
  const id = targetNodeId(input, ctx)
  const node = id ? ctx.findNode(id) : null
  return {
    label: { key: 'approval.field.target' },
    value: node
      ? { key: 'approval.value.node', params: { title: node.title } }
      : { key: 'approval.value.unknownNode', params: { id: id ?? '' } },
  }
}

/** 工具名行：给用户看的动作名，不是模型那边的标识符。 */
function toolRow(name: string): { label: ApprovalText; value: ApprovalText } {
  return { label: { key: 'approval.field.tool' }, value: { key: `approval.toolName.${name}` as ParseKeys<'chat'> } }
}

/**
 * 开放区判定：按 id 寻址的读工具用它把「越界」和「不存在」分开。
 *
 * 找不到节点 → `unresolved`（放行给工具，让它照常报错，不打扰用户）；
 * 找到但不在开放区 → `outside`（要问）；在开放区内 → 直接放行。
 */
function byNodeId(input: Record<string, unknown>, ctx: GateContext): ZoneVerdict {
  const id = argString(input, 'nodeId') || ctx.currentNodeId
  if (!id) return UNRESOLVED
  if (!ctx.findNode(id)) return UNRESOLVED
  return ctx.withinOpenZone(id) ? OPEN : { zone: 'outside' }
}

export const TOOL_GUARDS: Record<string, ToolGuard> = {
  // ── 读工具 ──────────────────────────────────────────────────────────────
  // 开放区 = 当前项目。以下四个只遍历本项目快照，构造上不可能越界，
  // 所以不挂 scope：真要越界，先得有「读别的项目」这个能力，那天再在这里接。
  search_nodes: {
    kind: 'read',
    describe: (input) => ({
      title: { key: 'approval.askTitle.search_nodes' },
      rows: [toolRow('search_nodes')],
      ...(argString(input, 'query')
        ? { reason: argString(input, 'query') }
        : {}),
    }),
  },
  get_tree_outline: {
    kind: 'read',
    describe: () => ({
      title: { key: 'approval.askTitle.get_tree_outline' },
      rows: [toolRow('get_tree_outline')],
    }),
  },
  list_note_labels: {
    kind: 'read',
    describe: () => ({
      title: { key: 'approval.askTitle.list_note_labels' },
      rows: [toolRow('list_note_labels')],
    }),
  },
  get_review_history: {
    kind: 'read',
    describe: (input, ctx) => ({
      title: { key: 'approval.askTitle.get_review_history' },
      rows: [toolRow('get_review_history'), nodeRow(input, ctx)],
    }),
  },
  // 按 id 寻址的读：要问「这个节点在不在开放区」
  get_node: {
    kind: 'read',
    scope: byNodeId,
    describe: (input, ctx, zone) => ({
      title: {
        key: zone.zone === 'outside' ? 'approval.askTitle.read_outside' : 'approval.askTitle.get_node',
      },
      rows: [
        toolRow('get_node'),
        nodeRow(input, ctx),
        ...(zone.zone === 'outside'
          ? [{ label: { key: 'approval.field.scope' as const }, value: { key: 'approval.scope.outsideProject' as const } }]
          : []),
      ],
    }),
  },
  search_notes: {
    kind: 'read',
    scope: (input, ctx) => {
      // 只有显式限定了 nodeId 才可能指向别处；不限定就是搜本项目全部标注
      const id = argString(input, 'nodeId')
      return id ? byNodeId(input, ctx) : OPEN
    },
    describe: (input, ctx, zone) => {
      const labels = argStrings(input, 'labels')
      const rows = [toolRow('search_notes')]
      if (argString(input, 'nodeId')) rows.push(nodeRow(input, ctx))
      if (labels.length > 0) {
        rows.push({
          label: { key: 'approval.field.labels' },
          value: { key: 'approval.value.labels', params: { labels: labels.join('、') } },
        })
      }
      if (zone.zone === 'outside') {
        rows.push({
          label: { key: 'approval.field.scope' },
          value: { key: 'approval.scope.outsideProject' },
        })
      }
      return {
        title: {
          key: zone.zone === 'outside' ? 'approval.askTitle.read_outside' : 'approval.askTitle.search_notes',
        },
        rows,
      }
    },
  },

  // ── 写工具：一律要问 ────────────────────────────────────────────────────
  create_node: {
    kind: 'write',
    describe: (input) => {
      const kind = argString(input, 'kind') || 'child'
      return {
        title: { key: 'approval.askTitle.create_node' },
        rows: [
          toolRow('create_node'),
          {
            label: { key: 'approval.field.target' },
            value: { key: 'approval.value.nodeTitle', params: { title: argString(input, 'title') } },
          },
          {
            label: { key: 'approval.field.kind' },
            value: { key: `approval.nodeKind.${kind}` as ParseKeys<'chat'>, params: { kind } },
          },
        ],
        ...(argString(input, 'seed') ? { reason: argString(input, 'seed') } : {}),
      }
    },
  },
  rename_node: {
    kind: 'write',
    describe: (input, ctx) => ({
      title: { key: 'approval.askTitle.rename_node' },
      rows: [
        toolRow('rename_node'),
        // 目标行显示**现有**标题（看得见才叫得清要改成什么），新标题单列一行
        { ...nodeRow(input, ctx), label: { key: 'approval.field.currentTitle' } },
        {
          label: { key: 'approval.field.newTitle' },
          value: { key: 'approval.value.nodeTitle', params: { title: argString(input, 'title') } },
        },
      ],
    }),
  },
  tag_span: {
    kind: 'write',
    describe: (input) => {
      const labels = argStrings(input, 'labels')
      return {
        title: { key: 'approval.askTitle.tag_span' },
        rows: [
          toolRow('tag_span'),
          {
            label: { key: 'approval.field.labels' },
            value: { key: 'approval.value.labels', params: { labels: labels.join('、') } },
          },
        ],
        ...(argString(input, 'quote') ? { reason: argString(input, 'quote') } : {}),
      }
    },
  },
  update_assessment: {
    kind: 'write',
    describe: (input, ctx) => ({
      title: { key: 'approval.askTitle.update_assessment' },
      rows: [toolRow('update_assessment'), nodeRow(input, ctx)],
      ...(argString(input, 'reason') ? { reason: argString(input, 'reason') } : {}),
    }),
  },
}

/** 没登记的工具：用工具名原样兜底，先问再说。 */
function unregisteredPrompt(name: string): ToolApprovalPrompt {
  return {
    title: { key: 'approval.askTitle.unregistered' },
    rows: [
      { label: { key: 'approval.field.tool' }, value: { key: 'approval.value.rawName', params: { name } } },
    ],
  }
}

/**
 * 这次调用要不要问用户。
 *
 * 规则只有一条：**写必问；读越界才问；没登记也问**。偏好为 `always_allow` 时
 * 一律放行——那个胶囊写的是「自动允许」，就得真的不再问，不留「只对写放行」
 * 这种要额外记的例外（读越界今天压根不触发，真要触发时该由 `withinOpenZone`
 * 那一处去决定，而不是让这个判定多出一个分支）。
 */
export function resolveToolApproval(
  name: string,
  input: unknown,
  ctx: GateContext,
): ToolApprovalVerdict {
  if (ctx.permission === 'always_allow') return { action: 'allow' }

  const guard = TOOL_GUARDS[name]
  if (!guard) return { action: 'ask', prompt: unregisteredPrompt(name) }

  const args = (input ?? {}) as Record<string, unknown>
  const zone: ZoneVerdict = guard.scope ? guard.scope(args, ctx) : OPEN
  // 读工具在开放区内（含目标压根不存在 —— 那是工具该报的错，不是用户的授权问题）
  if (guard.kind === 'read' && zone.zone !== 'outside') return { action: 'allow' }

  return { action: 'ask', prompt: guard.describe(args, ctx, zone) }
}

/** 拒绝后回给模型的说明：要它如实转告，并明确不许绕道重试。 */
export function deniedResult(name: string): string {
  return `用户拒绝了这次授权，${name} 没有执行。如实告诉用户他拒绝了，不要换个参数或换个工具重试。`
}

/**
 * 开放区判定的默认实现：节点属于当前项目即为区内。
 *
 * 快照（`ProjectSnapshot`）本身就是当前项目的全量，所以对现有工具恒为区内。
 * 跨项目检索落地时改这里（或换一个实现传进 `GateContext`）即可。
 */
export function withinOpenZone(nodeId: Id, nodes: Node[]): boolean {
  return nodes.some((node) => node.id === nodeId)
}
