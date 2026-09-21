/**
 * 开发脚本共用的路径、准备步骤与子进程工具。
 *
 * 抽出来的原因：同步服务的「跑起来之前要准备什么」（Prisma Client、SQLite 库、.env）
 * 对 `dev:all`（前后端一起）和 `dev:sync`（只起同步服务）是一模一样的。
 * 两份拷贝迟早会漂移成「一个能起、一个起不来」。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const serverDir = join(rootDir, 'server')

/** Windows 上 pnpm 是 .cmd，必须经 shell 才能被 spawn。 */
export const useShell = process.platform === 'win32'
export const pnpm = useShell ? 'pnpm.cmd' : 'pnpm'

export const viteBin = join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')
export const nestBin = join(serverDir, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js')

/** 带前缀转发一段输出：两个服务混在同一终端里也能分清谁说的。 */
export function relay(prefix, chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim()) process.stdout.write(`[${prefix}] ${line}\n`)
  }
}

/** 同步执行一步准备命令；失败即退出（准备没成功就别把服务拉起来）。 */
export function runOnce(label, args, cwd = serverDir) {
  const result = spawnSync(pnpm, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell,
  })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').toString().trim()
    console.error(`[dev] ${label} 失败（退出码 ${result.status}）：\n${detail}`)
    process.exit(1)
  }
}

/** Prisma Client 是否已生成（生成物落在 node_modules 里，卸载依赖后会消失）。 */
function prismaClientReady() {
  return existsSync(join(serverDir, 'node_modules', '.prisma', 'client', 'index.js'))
}

/**
 * 同步服务的启动准备（幂等）：依赖检查 → .env → Prisma Client → 数据库。
 *
 * 库里已有 dev.db 时不重复跑 migrate（迁移本身也幂等，但会多几秒启动时间）。
 */
export function prepareServer() {
  if (!existsSync(join(serverDir, 'node_modules'))) {
    console.error('[dev] 找不到同步服务依赖，请先执行：pnpm -C server install')
    process.exit(1)
  }

  if (!existsSync(join(serverDir, '.env'))) {
    console.warn('[dev] server/.env 不存在，正从 .env.example 生成')
    runOnce('cp .env', [
      'exec',
      'node',
      '-e',
      "require('fs').copyFileSync('.env.example','.env')",
    ])
  }

  // Windows 上 generate 会重写 query_engine 的 DLL：已有服务在跑时这个文件被占用，
  // 必然 EPERM。客户端已经生成过就跳过 —— 那是最常见的情形，也省一次启动开销；
  // 真没生成过（换机器、清过 node_modules）才必须生成，此时失败要挡住。
  if (!prismaClientReady()) {
    runOnce('prisma generate', ['prisma:generate'])
  }

  if (!existsSync(join(serverDir, 'prisma', 'dev.db'))) {
    console.log('[dev] 首次启动：初始化同步服务数据库')
    runOnce('prisma migrate', ['prisma:migrate'])
  }
}

/**
 * 拉起一个子进程，退出语义由调用方决定：
 * - 返回的 child 交给调用方管理生命周期
 * - `onExit` 在子进程退出时回调（用来收掉兄弟进程）
 *
 * 刻意不用 `shell: true`：这里启动的都是 `node.exe` 本身，多一层 cmd.exe
 * 只会让 `child.kill()` 打不准（杀掉的是壳，真正干活的进程留在后面）。
 */
export function spawnService({ prefix, command, args, cwd, onExit }) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  if (prefix) {
    child.stdout.on('data', (chunk) => relay(prefix, chunk))
    child.stderr.on('data', (chunk) => relay(prefix, chunk))
  }
  child.on('exit', (code, signal) => onExit?.(code, signal))
  return child
}

/**
 * 收掉一个子进程及其整棵子树。
 *
 * Windows 上没有进程组信号：`nest start --watch` 会再拉起 tsc 与真正的服务进程，
 * 只 kill 直接子进程会留下一串孤儿占着 3901，下次启动撞端口却查不出是谁。
 * 所以 Windows 走 `taskkill /T`，其余平台直接 kill。
 */
export function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill()
}
