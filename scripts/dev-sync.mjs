/**
 * `pnpm dev:sync`：只起同步服务（前端已在别处跑着时用）。
 *
 * 准备步骤见 `lib/dev-common.mjs`；这里只管进程与退出语义。
 */
import { existsSync } from 'node:fs'
import { killTree, nestBin, prepareServer, serverDir, spawnService } from './lib/dev-common.mjs'

if (!existsSync(nestBin)) {
  console.error('[dev:sync] 找不到 @nestjs/cli，请先执行：pnpm -C server install')
  process.exit(1)
}

prepareServer()

const child = spawnService({
  prefix: 'sync',
  command: process.execPath,
  args: [nestBin, 'start', '--watch'],
  cwd: serverDir,
  onExit: (code) => process.exit(code ?? 0),
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => killTree(child))
}
