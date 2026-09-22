import { describe, expect, it } from 'vitest'
import {
  clearLastOpenedNodeId,
  getLastOpenedNodeId,
  setLastOpenedNodeId,
} from './last-opened-node'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key: string) {
      return map.get(key) ?? null
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null
    },
    removeItem(key: string) {
      map.delete(key)
    },
    setItem(key: string, value: string) {
      map.set(key, value)
    },
  }
}

describe('last-opened-node helper', () => {
  it('正确保存、读取和清除特定项目的最后打开节点 ID', () => {
    const storage = memoryStorage()
    expect(getLastOpenedNodeId('proj-1', storage)).toBeNull()

    setLastOpenedNodeId('proj-1', 'node-101', storage)
    expect(getLastOpenedNodeId('proj-1', storage)).toBe('node-101')
    expect(getLastOpenedNodeId('proj-2', storage)).toBeNull()

    setLastOpenedNodeId('proj-2', 'node-202', storage)
    expect(getLastOpenedNodeId('proj-2', storage)).toBe('node-202')

    clearLastOpenedNodeId('proj-1', storage)
    expect(getLastOpenedNodeId('proj-1', storage)).toBeNull()
    expect(getLastOpenedNodeId('proj-2', storage)).toBe('node-202')
  })

  it('Storage 抛出异常时不崩溃，平稳降级', () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    } as unknown as Storage

    expect(() => {
      getLastOpenedNodeId('proj-1', throwingStorage)
    }).not.toThrow()
    expect(getLastOpenedNodeId('proj-1', throwingStorage)).toBeNull()

    expect(() => {
      setLastOpenedNodeId('proj-1', 'node-101', throwingStorage)
    }).not.toThrow()

    expect(() => {
      clearLastOpenedNodeId('proj-1', throwingStorage)
    }).not.toThrow()
  })
})
