import { describe, expect, it } from 'vitest'
import {
  AccountApiError,
  buildAccountRequest,
  interpretEnvelope,
  resolveAvatarUrl,
} from './client'

describe('buildAccountRequest', () => {
  it('把登录请求编码成 x-www-form-urlencoded', () => {
    const { url, init } = buildAccountRequest('/v1/user/pub/login', {
      method: 'POST',
      form: { username: 'testuser', password: 'p@ss word' },
    })

    expect(url).toBe('https://api.sakta.top/v1/user/pub/login')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' })
    expect(init.body).toBe('username=testuser&password=p%40ss+word')
  })

  it('把注册的 emailCode 放进查询参数，字段走 JSON 体', () => {
    const { url, init } = buildAccountRequest('/v1/user/pub/register', {
      method: 'POST',
      query: { emailCode: '123456' },
      json: { loginName: 'testuser', email: 'test@example.com' },
    })

    expect(url).toBe('https://api.sakta.top/v1/user/pub/register?emailCode=123456')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(init.body).toBe('{"loginName":"testuser","email":"test@example.com"}')
  })

  it('受保护接口带 token 头，无请求体时不下发 body', () => {
    const { init } = buildAccountRequest('/v1/user/pri/getInfo', { token: 'jwt-token' })

    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ token: 'jwt-token' })
    expect(init.body).toBeUndefined()
  })

  it('没有 token 时不发空的 token 头', () => {
    const { init } = buildAccountRequest('/v1/user/pub/sendCode', { method: 'POST', form: { email: 'a@b.c' } })

    expect((init.headers as Record<string, string>).token).toBeUndefined()
  })
})

describe('interpretEnvelope', () => {
  it('code 为 0 时原样返回信封', () => {
    const envelope = interpretEnvelope<never>({ code: 0, msg: '登录成功', token: 'jwt' }, 200)

    expect(envelope.token).toBe('jwt')
  })

  it('非 0 业务码抛错并保留上游文案', () => {
    // 上游对「用户不存在/密码错误」返回 HTTP 200 + code 500
    expect(() => interpretEnvelope({ code: 500, msg: '用户不存在/密码错误!' }, 200)).toThrow(
      '用户不存在/密码错误!',
    )
  })

  it('401 以业务码形式表达时按认证失败处理', () => {
    let thrown: unknown
    try {
      interpretEnvelope({ code: 401, msg: '消息头不正确，header需要携带token参数' }, 401)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AccountApiError)
    expect((thrown as AccountApiError).code).toBe(401)
  })

  it('缺少 code 字段时用 HTTP 状态兜底', () => {
    expect(() => interpretEnvelope({ msg: '网关错误' }, 502)).toThrow('网关错误')
  })

  it('响应体无法解析时报出 HTTP 状态', () => {
    expect(() => interpretEnvelope(null, 502)).toThrow(/无法解析/)
  })
})

describe('resolveAvatarUrl', () => {
  it('相对路径补全为账号服务地址', () => {
    expect(resolveAvatarUrl('/profile/avatar/example.png')).toBe(
      'https://api.sakta.top/profile/avatar/example.png',
    )
    expect(resolveAvatarUrl('profile/avatar/example.png')).toBe(
      'https://api.sakta.top/profile/avatar/example.png',
    )
  })

  it('绝对地址与 data URL 原样保留', () => {
    expect(resolveAvatarUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
    expect(resolveAvatarUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })

  it('空值返回 null', () => {
    expect(resolveAvatarUrl()).toBeNull()
    expect(resolveAvatarUrl('   ')).toBeNull()
  })
})