import i18n from '@/i18n'

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
  if (loginName.length < 2 || loginName.length > 20) return i18n.t('me:validation.loginNameLength')

  if (mode === 'login') {
    if (!form.password) return i18n.t('me:validation.passwordRequired')
    return null
  }

  if (form.password.length < 5 || form.password.length > 20) return i18n.t('me:validation.passwordLength')
  if (!EMAIL_PATTERN.test(form.email.trim())) return i18n.t('me:validation.emailInvalid')
  if (!new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(form.emailCode.trim())) {
    return i18n.t('me:validation.emailCodeLength', { length: EMAIL_CODE_LENGTH })
  }
  return null
}