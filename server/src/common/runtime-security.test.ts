import { describe, expect, it } from 'vitest'
import { createCorsOrigin, isProduction, shouldEnableDevToken } from './runtime-security'

describe('createCorsOrigin', () => {
  it('返回字符串/正则数组，绝不能是函数', () => {
    const origin = createCorsOrigin({ NODE_ENV: 'development', CORS_ORIGIN: '' })

    // cors 包把函数 origin 当异步回调 (origin, callback) 用；同步返回布尔的函数会让请求永久挂起
    expect(Array.isArray(origin)).toBe(true)
    origin.forEach((rule) => expect(typeof rule === 'string' || rule instanceof RegExp).toBe(true))
  })

  it('生产环境只认白名单', () => {
    expect(
      createCorsOrigin({ NODE_ENV: 'production', CORS_ORIGIN: 'https://learn.example.com' }),
    ).toEqual(['https://learn.example.com'])
  })

  it('开发环境额外放行本机任意端口，但不开给外部域名', () => {
    const origin = createCorsOrigin({ NODE_ENV: 'development', CORS_ORIGIN: '' })
    const allows = (value: string) =>
      origin.some((rule) => (typeof rule === 'string' ? rule === value : rule.test(value)))

    expect(allows('http://localhost:6180')).toBe(true)
    expect(allows('http://127.0.0.1:6174')).toBe(true)
    expect(allows('https://evil.example.com')).toBe(false)
  })

  it('白名单在开发环境同样生效', () => {
    const origin = createCorsOrigin({
      NODE_ENV: 'development',
      CORS_ORIGIN: 'https://learn.example.com, https://www.example.com',
    })
    const allows = (value: string) =>
      origin.some((rule) => (typeof rule === 'string' ? rule === value : rule.test(value)))

    expect(allows('https://learn.example.com')).toBe(true)
    expect(allows('https://www.example.com')).toBe(true)
  })
})

describe('shouldEnableDevToken', () => {
  it('生产环境恒不开启，哪怕显式配了', () => {
    expect(shouldEnableDevToken({ NODE_ENV: 'production', ALLOW_DEV_TOKEN: 'true' })).toBe(false)
    expect(shouldEnableDevToken({ NODE_ENV: 'development', ALLOW_DEV_TOKEN: 'true' })).toBe(true)
    expect(shouldEnableDevToken({ NODE_ENV: 'development', ALLOW_DEV_TOKEN: 'false' })).toBe(false)
  })

  it('是否生产只看 NODE_ENV', () => {
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true)
    expect(isProduction({})).toBe(false)
  })
})