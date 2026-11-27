/**
 * 构建后校验：`dist/unkernel/` 必须与 `public/unkernel/` 逐字节一致。
 *
 * unkernel 的页面是上游用 Vite 构建并压缩过的第三方产物，直接整目录复制进产物。
 * 如果复制过程被压缩器再处理一遍（例如 CopyRspackPlugin 的 info.minimized 丢了），
 * SWC 会把已经压缩过的代码重新改写：`vk-host` 分块里的
 * `for (let [e,t,r] of (a(...), a(...)))` 就是这样被造出来的 —— 循环头遮住了外层的
 * `r`，求值循环头时 `r` 还在 TDZ，Vulkan 渲染器加载直接失败（报
 * “can't access lexical declaration 'r' before initialization”），而同一份页面在
 * unkernel.dev 上却正常。这个校验保证那种回归在构建时就炸出来，而不是等用户
 * 在虚拟机里装好 Debian 才发现。
 *
 * 用法：pnpm build（脚本末尾自动调用），或 node scripts/check-unkernel-assets.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = path.join(root, 'public/unkernel')
const built = path.join(root, 'dist/unkernel')

/** 递归列出目录下的文件（相对路径，排序后比较） */
const listFiles = async (dir, prefix = '') => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(dir, entry.name), rel)))
    } else if (entry.isFile()) {
      files.push(rel)
    }
  }
  return files.sort()
}

const fail = (message) => {
  console.error(`✗ unkernel 页面校验失败：${message}`)
  console.error('  提示：rspack.config.ts 里复制 public/unkernel 的规则必须带 info: { minimized: true }，')
  console.error('  否则生产构建的压缩器会二次压缩上游已压缩的分块，改坏运行语义（Vulkan 渲染器加载失败）。')
  process.exit(1)
}

let sourceExists = true
try {
  await stat(source)
} catch {
  sourceExists = false
}
if (!sourceExists) {
  console.log('○ 没有 public/unkernel，跳过页面校验')
  process.exit(0)
}

const [sourceFiles, builtFiles] = await Promise.all([listFiles(source), listFiles(built)])

const missing = sourceFiles.filter((file) => !builtFiles.includes(file))
const extra = builtFiles.filter((file) => !sourceFiles.includes(file))
if (missing.length) {
  fail(`dist/unkernel 缺少 ${missing.length} 个文件（例如 ${missing[0]}）`)
}
if (extra.length) {
  fail(`dist/unkernel 多出 ${extra.length} 个文件（例如 ${extra[0]}）`)
}

/** 只逐字节比对脚本、样式与 HTML：镜像（.erofs）体积大且由 CopyRspackPlugin 原样搬运 */
const compareExt = new Set(['.js', '.mjs', '.css', '.html', '.json', '.webmanifest', '.md', '.svg'])

const changed = []
for (const file of sourceFiles) {
  if (!compareExt.has(path.extname(file))) {
    continue
  }
  const [a, b] = await Promise.all([
    readFile(path.join(source, file)),
    readFile(path.join(built, file)),
  ])
  if (!a.equals(b)) {
    changed.push(file)
  }
}

if (changed.length) {
  fail(
    `${changed.length} 个文件被构建改写过（例如 ${changed.slice(0, 3).join('、')}）：` +
      '它们应当与 public/unkernel 完全一致'
  )
}

console.log(
  `✓ unkernel 页面校验通过：${sourceFiles.length} 个文件与 public/unkernel 逐字节一致（比对 ${sourceFiles.filter((f) => compareExt.has(path.extname(f))).length} 个脚本 / 样式 / HTML）`
)
