/**
 * `pnpm dev:all`：同时拉起前端（Vite）与同步服务（Nest）。
 *
 * 为什么不用 concurrently：仓库里没有这个依赖，而需求小到不值得为它加一条 ——
 * pnpm 的 `--filter` 只在 workspace 里才有意义，server/ 是独立安装的。
 *
 * 关键是**退出语义**：任一子进程退出（含 Ctrl+C 打断）就把另一个也收掉。
 * 否则会留下孤儿进程占着端口，下次启动只报「3901 已被占用」，看不出是谁占的。
 */
import { existsSync } from 'node:fs'
import {
  killTree,
  nestBin,
  prepareServer,
  rootDir,
  serverDir,
  spawnService,
  viteBin,
} from './lib/dev-common.mjs'

if (!existsSync(viteBin)) {
  console.error('[dev:all] 找不到前端依赖，请先在仓库根目录执行 pnpm install')
  process.exit(1)
}
if (!existsSync(nestBin)) {
  console.error('[dev:all] 找不到 @nestjs/cli，请先执行：pnpm -C server install')
  process.exit(1)
}

prepareServer()

const children = []
let shuttingDown = false

function stopAll(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    killTree(child)
  }
  process.exit(exitCode)
}

function start(prefix, command, args, cwd) {
  const child = spawnService({
    prefix,
    command,
    args,
    cwd,
    onExit: (code, signal) => {
      if (shuttingDown) return
      console.error(`[dev:all] ${prefix} 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
      stopAll(code ?? 1)
    },
  })
  children.push(child)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stopAll(0))
}

start('sync', process.execPath, [nestBin, 'start', '--watch'], serverDir)
start('web', process.execPath, [viteBin], rootDir)
