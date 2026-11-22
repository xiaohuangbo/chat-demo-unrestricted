/**
 * 把 unkernel 的静态页面适配到应用的 `/unkernel/` 前缀。
 *
 * unkernel 的构建产物假设自己部署在站点根目录：发行版镜像写成
 * `/distros/...`，预览 Service Worker 注册到 `/vm-sw.js` / `/vm/`，manifest
 * 的 scope 是 `/`。应用把页面放在 `/unkernel/` 下，所以同步后要统一加前缀。
 *
 * 用法：pnpm patch:unkernel [页面目录]
 * 默认目录是 public/unkernel；重复运行是安全的。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? 'public/unkernel')
const read = (file) => readFile(path.join(root, file), 'utf8')
const write = (file, text) => writeFile(path.join(root, file), text)

const requireOnce = (text, marker, what) => {
  if (!text.includes(marker)) {
    throw new Error(`页面里找不到 ${what}（${marker}），构建产物可能变了`)
  }
}

const patchScripts = async () => {
  const assets = await readdir(path.join(root, 'assets'))
  const scripts = assets.filter((name) => name.startsWith('shortcuts-') && name.endsWith('.js'))
  if (scripts.length !== 1) {
    throw new Error(`期望 1 个 shortcuts-*.js，实际 ${scripts.length} 个`)
  }
  const file = path.join('assets', scripts[0])
  let text = await read(file)

  // 发行版镜像：两种引号都处理，避免压缩器换引号后漏掉。
  text = text.replaceAll('url:`/distros/', 'url:`/unkernel/distros/')
  text = text.replaceAll('url:"/distros/', 'url:"/unkernel/distros/')

  // 预览 Service Worker 的脚本地址与 scope。
  text = text.replaceAll('`/vm-sw.js`', '`/unkernel/vm-sw.js`')
  text = text.replaceAll('"/vm-sw.js"', '"/unkernel/vm-sw.js"')
  text = text.replaceAll('`/vm/', '`/unkernel/vm/')
  text = text.replaceAll('"/vm/"', '"/unkernel/vm/"')

  if (/url:[`"]\/distros\//.test(text)) {
    throw new Error('仍有未加 /unkernel 前缀的发行版 URL')
  }
  if (/[`"]\/vm-sw\.js[`"]/.test(text)) {
    throw new Error('仍有未加 /unkernel 前缀的 vm-sw.js')
  }
  await write(file, text)
  return file
}

const patchServiceWorker = async () => {
  let text = await read('vm-sw.js')
  text = text.replace('/^\\/vm\\/', '/^\\/unkernel\\/vm\\/')
  text = text.replace('`/vm/${vmId}', '`/unkernel/vm/${vmId}')
  text = text.replace('startsWith("/vm/")', 'startsWith("/unkernel/vm/")')

  requireOnce(text, '/^\\/unkernel\\/vm\\/', '预览正则')
  requireOnce(text, '`/unkernel/vm/${vmId}', '预览前缀')
  requireOnce(text, 'startsWith("/unkernel/vm/")', '预览页面过滤')
  await write('vm-sw.js', text)
  return 'vm-sw.js'
}

const patchManifest = async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'))
  manifest.id = '/unkernel/'
  manifest.start_url = '/unkernel/'
  manifest.scope = '/unkernel/'
  for (const icon of manifest.icons ?? []) {
    if (typeof icon.src === 'string' && icon.src.startsWith('/') && !icon.src.startsWith('/unkernel/')) {
      icon.src = `/unkernel${icon.src}`
    }
  }
  await write('manifest.webmanifest', `${JSON.stringify(manifest, null, '\t')}\n`)
  return 'manifest.webmanifest'
}

const patched = [await patchScripts(), await patchServiceWorker(), await patchManifest()]
console.log(`已适配 /unkernel/ 前缀：${patched.join(', ')}`)
