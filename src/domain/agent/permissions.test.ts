import { describe, expect, it } from 'vitest'
import type { Id, Node } from '@/domain/models'
import {
  TOOL_GUARDS,
  resolveToolApproval,
  withinOpenZone,
  type GateContext,
} from './permissions'

/**
 * 授权判定的口径测试。
 *
 * 这层是纯函数，所以不用起 store、不用起界面就能把「什么该问、什么不该问」
 * 全列出来验 —— 权限代码最怕的就是「改了一处规则，没人发现它把读也拦了」。
 */

function node(id: Id, title: string): Node {
  return {
    id,
    projectId: 'p1',
    parentId: null,
    forkFrom: null,
    title,
    position: null,
    status: 'active',
    kind: 'topic',
    thread: { entries: [], slots: {} },
    createdAt: 0,
    updatedAt: 0,
  } as Node
}

const NODES = [node('n1', '动量守恒'), node('n2', '碰撞恢复系数')]

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    currentNodeId: 'n1',
    findNode: (id) => {
      const found = NODES.find((item) => item.id === id)
      return found ? { id: found.id, title: found.title } : null
    },
    withinOpenZone: (id) => withinOpenZone(id, NODES),
    permission: 'prompt',
    ...overrides,
  }
}

const WRITE_TOOLS = ['create_node', 'rename_node', 'tag_span', 'update_assessment']
const READ_TOOLS = [
  'search_nodes',
  'get_node',
  'get_tree_outline',
  'list_note_labels',
  'search_notes',
  'get_review_history',
]

describe('工具授权判定', () => {
  it('每个写工具都必须问，没有例外', () => {
    for (const name of WRITE_TOOLS) {
      expect(TOOL_GUARDS[name].kind, name).toBe('write')
      expect(resolveToolApproval(name, {}, ctx()).action, name).toBe('ask')
    }
  })

  it('开放区内的读工具直接放行：区内检索是主力场景，弹卡就废掉了', () => {
    for (const name of READ_TOOLS) {
      expect(TOOL_GUARDS[name].kind, name).toBe('read')
      expect(resolveToolApproval(name, { nodeId: 'n2' }, ctx()).action, name).toBe('allow')
    }
  })

  it('读工具的入参非法也不该拦：那是工具该报的错，不是用户的授权问题', () => {
    // 目标压根解析不到 = 不存在/已删除，让 get_node 自己报「节点不存在」，
    // 而不是弹一张「要不要授权我读一个不存在的东西」
    expect(resolveToolApproval('get_node', { nodeId: 'nope' }, ctx()).action).toBe('allow')
    expect(resolveToolApproval('get_node', {}, ctx({ currentNodeId: undefined })).action).toBe(
      'allow',
    )
  })

  it('读工具越出开放区才问，并在卡片上说清范围', () => {
    // 模拟跨项目检索落地后的样子：节点找得到，但不在区内
    const outside = ctx({ withinOpenZone: (id) => id === 'n1' })
    const verdict = resolveToolApproval('get_node', { nodeId: 'n2' }, outside)
    expect(verdict.action).toBe('ask')
    if (verdict.action !== 'ask') return
    expect(verdict.prompt.title.key).toBe('approval.askTitle.read_outside')
    expect(verdict.prompt.rows.at(-1)).toMatchObject({
      label: { key: 'approval.field.scope' },
      value: { key: 'approval.scope.outsideProject' },
    })
  })

  it('search_notes 只在显式指定了 nodeId 时才可能越界', () => {
    const outside = ctx({ withinOpenZone: (id) => id === 'n1' })
    expect(resolveToolApproval('search_notes', { labels: ['mistake'] }, outside).action).toBe(
      'allow',
    )
    expect(
      resolveToolApproval('search_notes', { nodeId: 'n2', labels: ['mistake'] }, outside).action,
    ).toBe('ask')
  })

  it('没登记的工具一律先问（fail-closed）：新加工具忘了登记不该被静默放行', () => {
    const verdict = resolveToolApproval('brand_new_tool', { foo: 1 }, ctx())
    expect(verdict.action).toBe('ask')
    if (verdict.action !== 'ask') return
    expect(verdict.prompt.title.key).toBe('approval.askTitle.unregistered')
    expect(verdict.prompt.rows[0].value.params).toEqual({ name: 'brand_new_tool' })
  })

  it('自动允许是总开关：写与越界读一并放行', () => {
    const auto = ctx({ permission: 'always_allow' })
    expect(resolveToolApproval('create_node', {}, auto).action).toBe('allow')
    // 连「越界读」也放行 —— 胶囊上写的是「自动允许」，就得真的不再问
    expect(
      resolveToolApproval('get_node', { nodeId: 'n2' }, ctx({
        ...auto,
        withinOpenZone: () => false,
      })).action,
    ).toBe('allow')
  })

  it('写工具的卡片写得出人话：目标、类型、理由都要在', () => {
    const create = resolveToolApproval(
      'create_node',
      { kind: 'diverge', title: '换个方向', seed: '从能量守恒看' },
      ctx(),
    )
    if (create.action !== 'ask') throw new Error('应当询问')
    expect(create.prompt.rows.map((row) => row.value.key)).toEqual([
      'approval.toolName.create_node',
      'approval.value.nodeTitle',
      'approval.nodeKind.diverge',
    ])
    expect(create.prompt.rows[1].value.params).toEqual({ title: '换个方向' })
    expect(create.prompt.reason).toBe('从能量守恒看')

    const rename = resolveToolApproval('rename_node', { title: '新名字' }, ctx())
    if (rename.action !== 'ask') throw new Error('应当询问')
    // 「当前标题 / 改为」两行：看得见才叫得清要改成什么
    expect(rename.prompt.rows.map((row) => row.label.key)).toEqual([
      'approval.field.tool',
      'approval.field.currentTitle',
      'approval.field.newTitle',
    ])
    expect(rename.prompt.rows[1].value.params).toEqual({ title: '动量守恒' })
  })

  it('开放区默认实现就是「属于当前项目」', () => {
    expect(withinOpenZone('n1', NODES)).toBe(true)
    expect(withinOpenZone('elsewhere', NODES)).toBe(false)
  })
})
