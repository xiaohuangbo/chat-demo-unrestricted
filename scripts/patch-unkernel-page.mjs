/**
 * 把 unkernel 的静态页面适配到应用的 `/unkernel/` 前缀。
 *
 * unkernel 的构建产物假设自己部署在站点根目录：页面引用 `/assets/`，发行版
 * 镜像写成 `/distros/…`，预览 Service Worker 注册到 `/vm-sw.js` / `/vm/`，
 * manifest 的 scope 是 `/`。应用把页面放在 `/unkernel/` 下，所以同步后要统一
 * 加前缀。脚本重复运行是安全的：已加过前缀的路径不会再加一次。
 *
 * 用法：pnpm patch:unkernel [页面目录]
 * 默认目录是 public/unkernel。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? 'public/unkernel')
const PREFIX = '/unkernel'
const read = (file) => readFile(path.join(root, file), 'utf8')
const write = (file, text) => writeFile(path.join(root, file), text)

const requireOnce = (text, marker, what) => {
  if (!text.includes(marker)) {
    throw new Error(`页面里找不到 ${what}（${marker}），构建产物可能变了`)
  }
}

/** 加前缀：跳过已经带 /unkernel/ 的路径，避免重复运行把前缀叠起来 */
const withPrefix = (value) => (value.startsWith(`${PREFIX}/`) ? value : `${PREFIX}${value}`)

const HTML_FILES = ['index.html', 'profile.html', 'smp-probe.html', 'reset.html']

/** HTML 里的 href="/…"、src="/…" 换成 /unkernel/… */
const patchHtml = async (files) => {
  const patched = []
  for (const file of files) {
    let text
    try {
      text = await read(file)
    } catch {
      continue
    }
    text = text.replace(/\b(href|src)="(\/[^"]*)"/g, (_match, attr, value) => `${attr}="${withPrefix(value)}"`)
    await write(file, text)
    patched.push(file)
  }
  return patched
}

/** CSS 里的 url(/assets/…)（字体文件） */
const patchStyles = async () => {
  const assets = await readdir(path.join(root, 'assets'))
  const patched = []
  for (const name of assets.filter((item) => item.endsWith('.css'))) {
    const file = path.join('assets', name)
    let text = await read(file)
    text = text.replace(/url\((\/[^)]*)\)/g, (_match, value) => `url(${withPrefix(value)})`)
    await write(file, text)
    patched.push(file)
  }
  return patched
}

/**
 * JS 分块里的绝对路径：
 * - 发行版镜像 `` `/distros/…` ``；
 * - 预取 Service Worker `` `/vm-sw.js` `` 与预览路径 `` `/vm/…` ``；
 * - 动态资源 `` `/assets/…` ``（Worker、wasm、字体等，`new URL(…)` 的基准是页面根）；
 * - 许可页 `` `/licenses.md` ``。
 */
const patchScripts = async () => {
  const assets = await readdir(path.join(root, 'assets'))
  const scripts = assets.filter((name) => name.endsWith('.js'))
  if (scripts.length === 0) {
    throw new Error('assets/ 里没有 JS 分块，构建产物可能变了')
  }
  let distros = 0
  let serviceWorker = 0
  let prefixedDistros = 0
  let prefixedServiceWorker = 0
  for (const name of scripts) {
    const file = path.join('assets', name)
    let text = await read(file)
    const before = text
    prefixedDistros += text.split(`\`${PREFIX}/distros/`).length - 1
    prefixedServiceWorker += text.split(`\`${PREFIX}/vm-sw.js\``).length - 1
    text = text.replace(/`\/distros\//g, () => {
      distros += 1
      return `\`${PREFIX}/distros/`
    })
    text = text.replace(/`\/vm-sw\.js`/g, () => {
      serviceWorker += 1
      return `\`${PREFIX}/vm-sw.js\``
    })
    text = text.replace(/`\/vm\//g, `\`${PREFIX}/vm/`)
    text = text.replace(/`\/vm-ws\.js`/g, `\`${PREFIX}/vm-ws.js\``)
    text = text.replace(/`\/assets\//g, `\`${PREFIX}/assets/`)
    text = text.replace(/`\/licenses\.md`/g, `\`${PREFIX}/licenses.md\``)
    if (text !== before) {
      await write(file, text)
    }
  }
  // 重复运行（pnpm build 每次都会调用）时，上一次已经加过前缀，此时不再要求原始形态
  if (distros === 0 && prefixedDistros === 0) {
    throw new Error('JS 分块里没有找到发行版镜像 URL（`/distros/…`），构建产物可能变了')
  }
  if (serviceWorker === 0 && prefixedServiceWorker === 0) {
    throw new Error('JS 分块里没有找到 Service Worker 地址（`/vm-sw.js`），构建产物可能变了')
  }
  return scripts.length
}

/** 预览 Service Worker 自己的路径与正则 */
const patchServiceWorker = async () => {
  let text = await read('vm-sw.js')
  text = text.replaceAll('/^\\/vm\\//', `/^\\${PREFIX}\\/vm\\//`)
  text = text.replaceAll('`/vm/', `\`${PREFIX}/vm/`)
  text = text.replaceAll('"/vm/', `"${PREFIX}/vm/`)
  text = text.replaceAll('"/vm-ws.js"', `"${PREFIX}/vm-ws.js"`)
  requireOnce(text, `${PREFIX}/vm/`, '预览前缀')
  requireOnce(text, `${PREFIX}/vm-ws.js`, 'WebSocket shim 前缀')
  await write('vm-sw.js', text)
  return 'vm-sw.js'
}

const patchManifest = async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'))
  manifest.id = `${PREFIX}/`
  manifest.start_url = `${PREFIX}/`
  manifest.scope = `${PREFIX}/`
  for (const icon of manifest.icons ?? []) {
    if (typeof icon.src === 'string' && icon.src.startsWith('/') && !icon.src.startsWith(`${PREFIX}/`)) {
      icon.src = `${PREFIX}${icon.src}`
    }
  }
  await write('manifest.webmanifest', `${JSON.stringify(manifest, null, '\t')}\n`)
  return 'manifest.webmanifest'
}

const html = await patchHtml(HTML_FILES)
const styles = await patchStyles()
const scripts = await patchScripts()
const serviceWorker = await patchServiceWorker()
const manifest = await patchManifest()
console.log(
  `已适配 /unkernel/ 前缀：${[...html, ...styles, `${scripts} 个 JS 分块`, serviceWorker, manifest].join(', ')}`
)
