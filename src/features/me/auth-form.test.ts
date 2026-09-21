import { describe, expect, it } from 'vitest'
import { EMPTY_AUTH_FORM, validateAuthForm, type AuthForm } from './auth-form'

const form = (patch: Partial<AuthForm> = {}): AuthForm => ({ ...EMPTY_AUTH_FORM, ...patch })

describe('validateAuthForm', () => {
  it('登录只要求账号与密码', () => {
    expect(validateAuthForm('login', form({ loginName: 'testuser', password: '123456' }))).toBeNull()
    expect(validateAuthForm('login', form({ loginName: 'a', password: '123456' }))).toMatch(/2–20/)
    expect(validateAuthForm('login', form({ loginName: 'testuser' }))).toBe('请填写密码')
  })

  it('账号首尾空格不计入长度', () => {
    expect(validateAuthForm('login', form({ loginName: '  testuser  ', password: '123456' }))).toBeNull()
  })

  it('注册额外校验密码长度、邮箱与 6 位数字验证码', () => {
    const valid = form({
      loginName: 'testuser',
      password: '123456',
      email: 'test@example.com',
      emailCode: '123456',
    })

    expect(validateAuthForm('register', valid)).toBeNull()
    expect(validateAuthForm('register', { ...valid, password: '1234' })).toMatch(/5–20/)
    expect(validateAuthForm('register', { ...valid, password: 'x'.repeat(21) })).toMatch(/5–20/)
    expect(validateAuthForm('register', { ...valid, email: 'test@' })).toBe('请填写有效邮箱')
    expect(validateAuthForm('register', { ...valid, emailCode: '12345' })).toMatch(/6 位/)
    expect(validateAuthForm('register', { ...valid, emailCode: 'abcdef' })).toMatch(/6 位/)
  })

  it('注册时昵称留空不影响校验', () => {
    const valid = form({
      loginName: 'testuser',
      password: '123456',
      email: 'test@example.com',
      emailCode: '123456',
      userName: '',
    })

    expect(validateAuthForm('register', valid)).toBeNull()
  })
})