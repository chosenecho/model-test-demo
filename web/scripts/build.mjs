// 跨平台构建入口：等价于 `rm -rf dist && NODE_ENV=production rspack build`
// （rspack 的 output.clean 已负责清空 dist，这里只补 Windows 缺失的 env 前缀）
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'node_modules', '@rspack', 'cli', 'bin', 'rspack.js')

const result = spawnSync(process.execPath, [cli, 'build', '-c', 'rspack.config.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
})

process.exit(result.status ?? 1)
