import { describe, expect, it } from 'vitest'
import { isBlankCanvasOpen } from './blank-canvas'

const base = {
  loading: false,
  projectId: 'p1',
  workspaceProjectId: 'p1',
  isEmpty: true,
  dismissedFor: null,
}

describe('空白项目的落地画布', () => {
  it('空项目点进来就是展开画布', () => {
    expect(isBlankCanvasOpen(base)).toBe(true)
  })

  it('有节点的项目不占场，手动展开照旧', () => {
    expect(isBlankCanvasOpen({ ...base, isEmpty: false })).toBe(false)
  })

  it('数据还没载入时不算空项目（nodes 本来就是空的）', () => {
    expect(isBlankCanvasOpen({ ...base, loading: true })).toBe(false)
  })

  it('工作区里还是上一个项目的数据时不算空项目', () => {
    expect(isBlankCanvasOpen({ ...base, workspaceProjectId: 'p0' })).toBe(false)
    expect(isBlankCanvasOpen({ ...base, workspaceProjectId: null })).toBe(false)
  })

  it('没有项目 id 时不占场', () => {
    expect(isBlankCanvasOpen({ ...base, projectId: null })).toBe(false)
    expect(isBlankCanvasOpen({ ...base, projectId: undefined })).toBe(false)
  })

  it('用户收起过就不再占场（否则会像关不掉）', () => {
    expect(isBlankCanvasOpen({ ...base, dismissedFor: 'p1' })).toBe(false)
    // 收起的是别的项目，不影响本项目
    expect(isBlankCanvasOpen({ ...base, dismissedFor: 'p0' })).toBe(true)
  })
})
