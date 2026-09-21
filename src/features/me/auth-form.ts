export type AuthMode = 'login' | 'register'

export interface AuthForm {
  loginName: string
  password: string
  email: string
  emailCode: string
  userName: string
}

export const EMPTY_AUTH_FORM: AuthForm = {
  loginName: '',
  password: '',
  email: '',
  emailCode: '',
  userName: '',
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 注册验证码位数，与账号系统一致。 */
export const EMAIL_CODE_LENGTH = 6

/**
 * 校验边界照账号系统文档写死：登录账号 2–20 字符，密码 5–20 字符，验证码 6 位数字。
 * 本地先拦一道只是为了让用户立刻看到问题，最终仍以上游校验为准。
 */
export function validateAuthForm(mode: AuthMode, form: AuthForm): string | null {
  const loginName = form.loginName.trim()
  if (loginName.length < 2 || loginName.length > 20) return '登录账号需为 2–20 个字符'

  if (mode === 'login') {
    if (!form.password) return '请填写密码'
    return null
  }

  if (form.password.length < 5 || form.password.length > 20) return '密码需为 5–20 个字符'
  if (!EMAIL_PATTERN.test(form.email.trim())) return '请填写有效邮箱'
  if (!new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(form.emailCode.trim())) {
    return `邮箱验证码为 ${EMAIL_CODE_LENGTH} 位数字`
  }
  return null
}