export type RuntimeEnv = Record<string, string | undefined>

export function isProduction(env: RuntimeEnv = process.env): boolean {
  return env.NODE_ENV === 'production'
}

/**
 * 开发旁路 token：仅非生产且显式开启时，`dev-*` 前缀的 token 直接当成本地联调账号。
 * 生产环境恒不生效 —— 这是唯一能让请求绕过账号系统的口子。
 */
export function shouldEnableDevToken(env: RuntimeEnv = process.env): boolean {
  return !isProduction(env) && env.ALLOW_DEV_TOKEN === 'true'
}

/** 账号系统证书链在本机不被信任时（自签/中间证书缺失）跳过校验，仅非生产可用。 */
export function shouldEnableInsecureTls(env: RuntimeEnv = process.env): boolean {
  return !isProduction(env) && env.ALLOW_INSECURE_TLS === 'true'
}

export function shouldEnableSwagger(env: RuntimeEnv = process.env): boolean {
  if (env.ENABLE_SWAGGER !== undefined) {
    return env.ENABLE_SWAGGER === 'true' && !isProduction(env)
  }
  return !isProduction(env)
}

/**
 * CORS 允许来源。
 *
 * 必须返回字符串 / 正则数组，**不能返回函数**：`cors` 包把函数形式的 origin 当成
 * 异步回调 `(origin, callback)`，同步返回布尔的函数永远不调用 callback，
 * 结果是每个请求都挂住（实测：连接建立、零字节响应）。
 * 正则用来覆盖开发环境的端口漂移（Vite 从 6174 起向后找空闲端口）。
 */
export function createCorsOrigin(env: RuntimeEnv = process.env): (string | RegExp)[] {
  const allowed = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  if (isProduction(env)) return allowed

  return [
    ...allowed,
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https?:\/\/\[::1\](:\d+)?$/,
  ]
}