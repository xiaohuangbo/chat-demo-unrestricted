import { baseName, dirName, resolvePath } from '../fs.js'
import type { RuntimeIO, RuntimeModule, RuntimeProgress } from './types.js'

/**
 * Sass（dart-sass 官方编译器）浏览器运行时。
 *
 * 直接用 jsDelivr 的 `+esm` 入口动态 import（Rollup 把 sass.default.js 打成单文件
 * ESM，并自动带上 immutable 依赖），拿到官方的 `compileString` / `compile` /
 * `info` 等导出。这里用 `new Function` 包一层动态 import，避免 rspack 试图解析
 * 远程 URL。
 *
 * @use / @import 走自定义 importer，相对路径全部从 NanoVM 的虚拟文件系统解析：
 * 依次尝试原路径、补 .scss/.sass/.css、partial（_name.scss）与目录 index。
 * sass 的 legacy `render` 需要 Node 的 fs，浏览器里不可用；compileString + importer
 * 是官方推荐的浏览器路径。
 *
 * 已知限制：
 * - 不支持从 http(s) 或 npm 包加载样式表，只认 VFS；
 * - compileString 是同步的，编译超大文件时无法中途取消（命令前后会检查 signal）；
 * - 运行时是 CDN ESM，无法像 UMD 文本那样放进 Cache Storage，依赖浏览器 HTTP 缓存。
 */

const SASS_URL = 'https://cdn.jsdelivr.net/npm/sass@1.108.2/+esm'
const FALLBACK_VERSION = '1.108.2'
const FALLBACK_COMPILER = 'dart2js'

const SASS_EXTENSIONS = ['.scss', '.sass', '.css'] as const

type SassStyle = 'expanded' | 'compressed'

type SassSyntax = 'scss' | 'indented' | 'css'

type SassImporterResult = {
  contents: string
  syntax?: SassSyntax
}

type SassImporter = {
  canonicalize: (url: string) => URL | null
  load: (canonicalUrl: URL) => SassImporterResult | null
}

type SassLogger = {
  warn?: (message: string, options?: Record<string, unknown>) => void
  debug?: (message: string, options?: Record<string, unknown>) => void
}

type SassCompileOptions = {
  style?: SassStyle
  syntax?: SassSyntax
  url?: URL
  importer?: SassImporter
  alertColor?: boolean
  logger?: SassLogger
}

type SassCompileResult = {
  css: string
}

type SassModule = {
  info: string
  compileString: (source: string, options: SassCompileOptions) => SassCompileResult
}

type SassMode = 'version' | 'help' | 'error' | 'run'

type SassInvocation = {
  mode: SassMode
  input: string | null
  output: string | null
  style: SassStyle
  message?: string
}

type SassVersion = {
  version: string
  compiler: string
}

const USAGE = [
  '用法：sass [选项] 输入.scss [输出.css]',
  '',
  '  --style=expanded|compressed  输出风格（默认 expanded）',
  '  -v, --version                显示版本',
  '  -h, --help                   显示本说明',
  '',
  '输入写 - 时从标准输入读取；省略输出文件时把 CSS 写到标准输出。',
  '@use / @import 从 NanoVM 虚拟文件系统解析，支持相对路径、partial（_name.scss）',
  '与目录 index；不支持 http(s) 远程样式表或 npm 包。',
  '',
].join('\n')

/** 远程 ESM 只能靠原生 import 加载，`new Function` 里的 import 不会被 rspack 打包 */
const importRemote = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

let loadedModule: SassModule | null = null
let loadingModule: Promise<SassModule> | null = null
let detectedVersion: SassVersion = {
  version: FALLBACK_VERSION,
  compiler: FALLBACK_COMPILER,
}

const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const extensionOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

const syntaxForPath = (path: string): SassSyntax => {
  const extension = extensionOf(path)
  if (extension === '.sass') {
    return 'indented'
  }
  if (extension === '.css') {
    return 'css'
  }
  return 'scss'
}

/** 把 VFS 绝对路径转成 file URL；逐段编码，避免空格 / # 被当成 URL 语法 */
const fileUrlFor = (path: string): URL => {
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return new URL(`file://${encoded.startsWith('/') ? '' : '/'}${encoded}`)
}

/** 从 import URL 里取出 VFS 路径；只接受 file: scheme */
const vfsPathFromUrl = (raw: string, base: URL): string | null => {
  let parsed: URL
  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)
    parsed = hasScheme ? new URL(raw) : new URL(raw, base)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:') {
    return null
  }
  try {
    return decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
}

const partialPath = (path: string): string => {
  const dir = dirName(path)
  const prefix = dir === '/' ? '/' : `${dir}/`
  return `${prefix}_${baseName(path)}`
}

/** Sass 的候选文件顺序：原路径 → 补扩展名 → partial → 目录 index */
const importCandidates = (path: string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (value: string): void => {
    if (value !== '' && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  const extension = extensionOf(path)
  if (extension === '.scss' || extension === '.sass' || extension === '.css') {
    add(path)
    add(partialPath(path))
    return out
  }
  add(path)
  for (const candidateExtension of SASS_EXTENSIONS) {
    add(`${path}${candidateExtension}`)
    add(partialPath(`${path}${candidateExtension}`))
  }
  for (const candidateExtension of SASS_EXTENSIONS) {
    add(`${path}/_index${candidateExtension}`)
    add(`${path}/index${candidateExtension}`)
  }
  return out
}

/** 从 VFS 解析 @use / @import；解析不到返回 null，由 sass 给标准报错 */
const createImporter = (io: RuntimeIO, base: URL): SassImporter => ({
  canonicalize: (url: string): URL | null => {
    const path = vfsPathFromUrl(String(url), base)
    if (path === null) {
      return null
    }
    for (const candidate of importCandidates(path)) {
      try {
        if (io.fs.stat(candidate)?.kind === 'file') {
          return fileUrlFor(candidate)
        }
      } catch {
        // stat 失败按「这个候选不存在」处理，继续试下一个
      }
    }
    return null
  },
  load: (canonicalUrl: URL): SassImporterResult | null => {
    let path: string
    try {
      path = decodeURIComponent(canonicalUrl.pathname)
    } catch {
      return null
    }
    let contents: string | null
    try {
      contents = io.fs.readText(path)
    } catch {
      return null
    }
    if (contents === null) {
      return null
    }
    return { contents, syntax: syntaxForPath(path) }
  },
})

/** 读取 info 文本的前两行：`dart-sass\t1.108.2\t...` 与 `dart2js\t3.13.7\t...` */
const parseVersion = (info: string): SassVersion => {
  const lines = info.split('\n')
  const first = (lines[0] ?? '').split('\t')
  const second = (lines[1] ?? '').split('\t')
  const version = first[1]?.trim() || FALLBACK_VERSION
  const compiler = second[0] && second[1] ? `${second[0].trim()} ${second[1].trim()}` : ''
  return { version, compiler }
}

const createModule = async (onProgress: RuntimeProgress): Promise<SassModule> => {
  onProgress(0.1)
  let value: unknown
  try {
    value = await importRemote(SASS_URL)
  } catch (error) {
    throw new Error(`sass 运行时下载失败，请检查网络：${errorText(error)}`)
  }
  onProgress(0.6)
  if (!isRecord(value) || typeof value.compileString !== 'function') {
    throw new Error('sass 模块格式异常：缺少 compileString 导出')
  }
  const info = typeof value.info === 'string' ? value.info : ''
  detectedVersion = parseVersion(info)
  onProgress(0.9)
  return {
    info,
    compileString: value.compileString as SassModule['compileString'],
  }
}

const ensureModule = async (onProgress: RuntimeProgress): Promise<SassModule> => {
  if (loadedModule) {
    onProgress(1)
    return loadedModule
  }
  if (loadingModule) {
    const module = await loadingModule
    onProgress(1)
    return module
  }
  const pending = createModule(onProgress)
  loadingModule = pending
  try {
    const module = await pending
    loadedModule = module
    onProgress(1)
    return module
  } finally {
    loadingModule = null
  }
}

/** 解析命令行；argv 不含命令名 */
const parseInvocation = (argv: string[]): SassInvocation => {
  const out: SassInvocation = {
    mode: 'run',
    input: null,
    output: null,
    style: 'expanded',
  }
  const fail = (message: string): SassInvocation => ({ ...out, mode: 'error', message })
  const positionals: string[] = []
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === undefined) {
      break
    }
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (arg === '--version' || arg === '-v') {
      return { ...out, mode: 'version' }
    }
    if (arg === '--help' || arg === '-h') {
      return { ...out, mode: 'help' }
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      index += 1
      continue
    }
    if (!arg.startsWith('--')) {
      return fail(`sass: 无法识别的选项 '${arg}'\n${USAGE}`)
    }
    const body = arg.slice(2)
    const equals = body.indexOf('=')
    const name = equals >= 0 ? body.slice(0, equals) : body
    let value = equals >= 0 ? body.slice(equals + 1) : null
    if (name !== 'style') {
      return fail(`sass: 无法识别的选项 '${arg}'\n${USAGE}`)
    }
    if (value === null) {
      const next = argv[index + 1]
      if (next === undefined) {
        return fail('sass: --style 需要一个值（expanded / compressed）\n')
      }
      value = next
      index += 1
    }
    if (value !== 'expanded' && value !== 'compressed') {
      return fail(`sass: 不支持的 style '${value}'（可用 expanded / compressed）\n`)
    }
    out.style = value
    index += 1
  }
  if (positionals.length === 0) {
    return fail(`sass: 缺少输入文件\n${USAGE}`)
  }
  if (positionals.length > 2) {
    return fail(`sass: 只能指定一个输入和一个输出（多余的 '${positionals[2] ?? ''}'）\n`)
  }
  out.input = positionals[0] ?? null
  out.output = positionals[1] ?? null
  return out
}

/** 读输入；写回失败也给中文错误 */
const readInput = (
  io: RuntimeIO,
  display: string
): { source: string; path: string; syntax: SassSyntax } | null => {
  if (display === '-') {
    return {
      source: io.stdin,
      path: resolvePath(io.cwd, 'stdin.scss'),
      syntax: 'scss',
    }
  }
  const path = resolvePath(io.cwd, display)
  const stat = io.fs.stat(path)
  if (!stat) {
    io.stderr(`sass: 找不到文件 '${display}'\n`)
    return null
  }
  if (stat.kind === 'dir') {
    io.stderr(`sass: '${display}' 是一个目录\n`)
    return null
  }
  let source: string | null
  try {
    source = io.fs.readText(path)
  } catch (error) {
    io.stderr(`sass: 读取 '${display}' 失败：${errorText(error)}\n`)
    return null
  }
  if (source === null) {
    io.stderr(`sass: 找不到文件 '${display}'\n`)
    return null
  }
  return { source, path, syntax: syntaxForPath(path) }
}

const writeOutput = (io: RuntimeIO, path: string, css: string): boolean => {
  try {
    io.fs.mkdir(dirName(path), true)
    io.fs.writeText(path, css)
    return true
  } catch (error) {
    io.stderr(`sass: 写入 ${path} 失败：${errorText(error)}\n`)
    return false
  }
}

const runSass = async (argv: string[], io: RuntimeIO): Promise<{ code: number }> => {
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  const invocation = parseInvocation(argv)
  if (invocation.mode === 'version') {
    const suffix = detectedVersion.compiler ? ` compiled with ${detectedVersion.compiler}` : ''
    io.stdout(`${detectedVersion.version}${suffix}\n`)
    return { code: 0 }
  }
  if (invocation.mode === 'help') {
    io.stdout(USAGE)
    return { code: 0 }
  }
  if (invocation.mode === 'error') {
    io.stderr(invocation.message ?? 'sass: 参数错误\n')
    return { code: 1 }
  }
  if (!invocation.input) {
    io.stderr(`sass: 缺少输入文件\n${USAGE}`)
    return { code: 1 }
  }

  let module: SassModule
  try {
    module = await ensureModule(() => undefined)
  } catch (error) {
    io.stderr(
      `sass: Sass 运行时加载失败，需要联网（首次安装约 5.8MB）：${errorText(error)}\n` +
        '提示：连上网后执行 vm install sass，装好之后本页内可复用。\n'
    )
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  const input = readInput(io, invocation.input)
  if (!input) {
    return { code: 1 }
  }
  const base = fileUrlFor(input.path)
  let css: string
  try {
    const result = module.compileString(input.source, {
      style: invocation.style,
      syntax: input.syntax,
      url: base,
      importer: createImporter(io, base),
      alertColor: false,
      logger: {
        warn: (message) => {
          io.stderr(`sass: 警告：${message}\n`)
        },
        debug: (message) => {
          io.stderr(`sass: ${message}\n`)
        },
      },
    })
    if (!isRecord(result) || typeof result.css !== 'string') {
      io.stderr('sass: 编译器返回结果格式异常\n')
      return { code: 1 }
    }
    css = result.css
  } catch (error) {
    io.stderr(`sass: ${errorText(error)}\n`)
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  if (invocation.output === null) {
    io.stdout(css.endsWith('\n') ? css : `${css}\n`)
  } else {
    const target = resolvePath(io.cwd, invocation.output)
    if (!writeOutput(io, target, css)) {
      return { code: io.signal?.aborted ? 130 : 1 }
    }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  return { code: 0 }
}

/** Sass 1.108（jsDelivr +esm 浏览器构建）：compileString + VFS importer */
export const sassRuntime: RuntimeModule = {
  load: async (onProgress) => {
    const module = await ensureModule(onProgress)
    const version = parseVersion(module.info).version
    return { version }
  },
  run: async (argv, io) => {
    try {
      return await runSass(argv, io)
    } catch (error) {
      io.stderr(`sass: ${errorText(error)}\n`)
      return { code: 1 }
    }
  },
  dispose: () => {
    loadedModule = null
    loadingModule = null
    detectedVersion = { version: FALLBACK_VERSION, compiler: FALLBACK_COMPILER }
  },
}
