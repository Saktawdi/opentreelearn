import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { LanguageModel } from 'ai'
import { buildStreamOptions, streamReply } from './chat'
import { buildReadOnlyTools } from './tools/registry'

/**
 * 中断（abort）不该在浏览器里留下未处理的 promise rejection。
 *
 * 背景：`streamText` 会把 `result.usage` 包一层 `.then(() => {})` 交给遥测通道当完成信号，
 * 而只读 `.catch()` 兜底的是 Node 分支（`openTelemetryChannelSpanContext` 里
 * `isNodeRuntime()` 为真才走到）。浏览器里这段派生 promise 无人接住：一旦在**第一个 step
 * 结束前**中断，SDK 会用 `abortSignal.reason` 拒绝全部结果 promise，于是控制台出现
 * 「Uncaught (in promise) DOMException: The operation was aborted.」。
 *
 * 这里把运行环境伪装成浏览器（SDK 判定运行时看的是 `process.release.name`），
 * 复现该时序并断言不再有未处理的 rejection。
 */

const realRelease = process.release

function fakeBrowserRuntime(): void {
  Object.defineProperty(process, 'release', {
    value: { name: 'vite-browser' },
    configurable: true,
  })
}

function restoreRuntime(): void {
  Object.defineProperty(process, 'release', { value: realRelease, configurable: true })
}

/** 上游：响应头已到、一个 chunk 都没吐，被中断时以 signal.reason 结束响应体（真实 fetch 的行为）。 */
function hangingStream(signal: AbortSignal): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
    },
    pull(controller) {
      return new Promise<void>((resolve) => {
        const fail = () => {
          try {
            controller.error(signal.reason)
          } catch {
            // 流已关闭
          }
          resolve()
        }
        if (signal.aborted) return fail()
        signal.addEventListener('abort', fail, { once: true })
      })
    },
  })
}

let unhandled: unknown[] = []
const collect = (reason: unknown) => {
  unhandled.push(reason)
}

beforeEach(() => {
  unhandled = []
  fakeBrowserRuntime()
  process.on('unhandledRejection', collect)
})

afterEach(() => {
  process.off('unhandledRejection', collect)
  restoreRuntime()
})

describe('streamReply 的中断处理', () => {
  it('第一个 step 结束前中断，不产生未处理的 rejection', async () => {
    const controller = new AbortController()
    const model = new MockLanguageModelV3({
      doStream: async (options) => ({
        stream: hangingStream(options.abortSignal ?? controller.signal),
      }),
    })

    const pending = streamReply({
      model,
      system: '系统提示',
      messages: [{ role: 'user', content: '你好' }],
      abortSignal: controller.signal,
    })

    // 让请求真正挂在上游，再中断：这是「加载即中断 / 点了停止」的时序
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    const result = await pending
    // 中断后要落在「没有正文」的稳定结果上，调用方据此回滚阶段
    expect(result.text).toBe('')
    expect(result.usage).toBeUndefined()

    // 未处理的 rejection 在微任务队列排空后才上报
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(unhandled).toEqual([])
  })
})

describe('buildStreamOptions（带不带工具的请求体差异）', () => {
  const base = {
    model: {} as LanguageModel,
    system: '系统提示',
    messages: [{ role: 'user' as const, content: '问' }],
  }
  const tools = buildReadOnlyTools({
    nodes: [],
    messagesByNode: new Map(),
    notes: [],
    approvalPolicy: 'open',
    permission: 'prompt',
  })

  it('不带工具时完全不出现 tools / stopWhen（回归底线：请求体与今天逐字节一致）', () => {
    const options = buildStreamOptions(base)
    expect('tools' in options).toBe(false)
    expect('stopWhen' in options).toBe(false)
    expect(options.telemetry).toEqual({ isEnabled: false })
  })

  it('把空工具集当成没有工具', () => {
    const options = buildStreamOptions({ ...base, tools: {} })
    expect('tools' in options).toBe(false)
    expect('stopWhen' in options).toBe(false)
  })

  it('带工具时同时给出 tools 与步数上限', () => {
    const options = buildStreamOptions({ ...base, tools, maxSteps: 3 })
    expect(options.tools).toBe(tools)
    expect(options.stopWhen).toBeDefined()
  })

  it('maxSteps = 0 表示不限制步数：传 stopWhen: []，绝不能不传（否则 SDK 默认 stepCountIs(1) 会变 1 步截断）', () => {
    const options = buildStreamOptions({ ...base, tools, maxSteps: 0 })
    expect(options.tools).toBe(tools)
    // 必须存在且为空数组（永不满足的停止条件）
    expect(options.stopWhen).toEqual([])
  })

  it('给出合法推理强度时注入顶层 reasoning（同一回归底线：不设置就不出现该键）', () => {
    const options = buildStreamOptions({ ...base, reasoningEffort: 'high' })
    expect(options.reasoning).toBe('high')
  })

  it('auto / 非法档位 / 缺省都不出现 reasoning 键（回归底线不破）', () => {
    expect('reasoning' in buildStreamOptions({ ...base, reasoningEffort: 'auto' })).toBe(false)
    expect('reasoning' in buildStreamOptions({ ...base, reasoningEffort: 'unknown_effort' })).toBe(false)
    expect('reasoning' in buildStreamOptions({ ...base, reasoningEffort: '超强' })).toBe(false)
    expect('reasoning' in buildStreamOptions(base)).toBe(false)
  })
})
