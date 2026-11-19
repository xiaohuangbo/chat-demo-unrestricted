import { dirName, resolvePath } from '../fs.js'
import type { RuntimeIO, RuntimeModule, RuntimeProgress } from './types.js'

/**
 * Prettier（官方代码格式化器）浏览器运行时。
 *
 * standalone 构建不包含任何语言插件，必须单独加载并把插件对象传给
 * `prettier.format({ plugins })`。这里从 jsDelivr 分别取 standalone.js 与
 * estree / babel / typescript / postcss / markdown / yaml 六个插件（都是 UMD），
 * 每个文件单独进 Cache Storage（`nanovm-prettier-cache`）。
 *
 * UMD 都在一个沙箱对象里执行：standalone 往 `globalThis.prettier` 上挂 API，
 * 插件往 `globalThis.prettierPlugins` 上注册；沙箱继承 window，既拿得到原生
 * 全局，又不会污染页面上的 prettier。安装时把六个插件都预取（约 2MB），
 * 这样离线也能用；run 里仍按 parser 只把需要的插件传进 options。
 *
 * 命令：`prettier [--check|--write] [--parser=...] [--print-width=100]
 * [--single-quote|--no-single-quote] 文件...`。没有 --parser 时按扩展名推断。
 */

const PRETTIER_BASE = 'https://cdn.jsdelivr.net/npm/prettier@3.10.1/'
const STANDALONE_URL = `${PRETTIER_BASE}standalone.js`
const CACHE_NAME = 'nanovm-prettier-cache'
const FALLBACK_VERSION = '3.10.1'

const PLUGIN_NAMES = ['estree', 'babel', 'typescript', 'postcss', 'markdown', 'yaml'] as const

type PluginName = (typeof PLUGIN_NAMES)[number]

/** prettier 的插件对象形状不固定，只保证是对象并按下标取用 */
type PrettierPlugin = Record<string, unknown>

type PrettierApi = {
  version: string
  format: (source: string, options: Record<string, unknown>) => Promise<string>
  check: (source: string, options: Record<string, unknown>) => Promise<boolean>
}

type PrettierBundle = {
  prettier: PrettierApi
  plugins: Record<PluginName, PrettierPlugin>
}

type PrettierMode = 'version' | 'help' | 'error' | 'run'

type PrettierInvocation = {
  mode: PrettierMode
  files: string[]
  write: boolean
  check: boolean
  parser: string | null
  printWidth: number
  singleQuote: boolean
  message?: string
}

type ResolvedParser = {
  parser: string
  plugins: PluginName[]
}

type Sandbox = Record<string, unknown>

const USAGE = [
  '用法：prettier [选项] 文件...',
  '',
  '  --check               只检查格式；有文件不符合时退出 1',
  '  --write               就地写回虚拟文件系统',
  '  --parser=类型         babel / typescript / postcss / json / markdown / yaml',
  '  --print-width=100     每行最大宽度（默认 80）',
  '  --single-quote        使用单引号（--no-single-quote 关闭）',
  '  -v, --version         显示版本',
  '  -h, --help            显示本说明',
  '',
  '省略 --parser 时按扩展名推断：.ts/.tsx → typescript，.js/.jsx → babel，',
  '.css/.scss → postcss，.json → json，.md → markdown，.yaml/.yml → yaml。',
  '没有 --check / --write 时把格式化结果写标准输出，多文件用 `// --- 文件 ---` 分隔。',
  '',
].join('\n')

let loadedBundle: PrettierBundle | null = null
let loadingBundle: Promise<PrettierBundle> | null = null
let detectedVersion = FALLBACK_VERSION

const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const cacheStorage = (): CacheStorage | null => {
  try {
    return typeof caches === 'undefined' ? null : caches
  } catch {
    return null
  }
}

const readCachedText = async (url: string): Promise<string | null> => {
  const storage = cacheStorage()
  if (!storage) {
    return null
  }
  try {
    const cache = await storage.open(CACHE_NAME)
    const response = await cache.match(url)
    return response ? await response.text() : null
  } catch {
    return null
  }
}

const writeCachedText = async (url: string, source: string): Promise<void> => {
  const storage = cacheStorage()
  if (!storage) {
    return
  }
  try {
    const cache = await storage.open(CACHE_NAME)
    await cache.put(
      url,
      new Response(source, {
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
      })
    )
  } catch {
    // 缓存失败不影响本次使用
  }
}

const fetchText = async (url: string): Promise<string> => {
  const cached = await readCachedText(url)
  if (cached !== null) {
    return cached
  }
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(`下载 ${url} 失败，请检查网络：${errorText(error)}`)
  }
  if (!response.ok) {
    throw new Error(`下载 ${url} 失败：HTTP ${response.status}`)
  }
  const source = await response.text()
  await writeCachedText(url, source)
  return source
}

/**
 * 以 window 为底座的写时复制沙箱。
 *
 * 不能用 Object.create(globalThis)：浏览器里 document / location 等是 Window
 * 原型上的 getter，经原型链读取时 receiver 会变成沙箱对象，触发
 * “Illegal invocation”。Proxy 的 get 明确用 window 作为 receiver，
 * UMD 的写入则落在 overlay 里，不会污染页面。
 */
const createSandbox = (): Sandbox => {
  const overlay = new Map<string | symbol, unknown>()
  return new Proxy(globalThis, {
    get: (target, property) => {
      if (overlay.has(property)) {
        return overlay.get(property)
      }
      return Reflect.get(target, property, target)
    },
    set: (_target, property, value) => {
      overlay.set(property, value)
      return true
    },
    has: (target, property) => overlay.has(property) || Reflect.has(target, property),
    deleteProperty: (_target, property) => {
      overlay.delete(property)
      return true
    },
    getOwnPropertyDescriptor: (target, property) => {
      if (overlay.has(property)) {
        return {
          value: overlay.get(property),
          writable: true,
          enumerable: true,
          configurable: true,
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, property)
    },
    ownKeys: (target) => {
      const keys = new Set<string | symbol>(Reflect.ownKeys(target))
      for (const key of overlay.keys()) {
        keys.add(key)
      }
      return [...keys]
    },
  }) as unknown as Sandbox
}

/** 在沙箱里执行 UMD；`this` 与 globalThis 都指向沙箱，避免污染页面全局 */
const evaluateUmd = (source: string, sandbox: Sandbox): void => {
  const factory = new Function('globalThis', 'module', 'exports', 'define', source) as (
    this: Sandbox,
    global: Sandbox,
    module: undefined,
    exports: undefined,
    define: undefined
  ) => void
  factory.call(sandbox, sandbox, undefined, undefined, undefined)
}

const pluginUrl = (name: PluginName): string => `${PRETTIER_BASE}plugins/${name}.js`

const createBundle = async (onProgress: RuntimeProgress): Promise<PrettierBundle> => {
  onProgress(0.1)
  const sandbox = createSandbox()
  const standalone = await fetchText(STANDALONE_URL)
  evaluateUmd(standalone, sandbox)
  const prettier = sandbox.prettier
  if (!isRecord(prettier) || typeof prettier.format !== 'function') {
    throw new Error('Prettier standalone 初始化失败：没有拿到 format')
  }
  detectedVersion =
    typeof prettier.version === 'string' && prettier.version !== ''
      ? prettier.version
      : FALLBACK_VERSION
  onProgress(0.6)

  const plugins = {} as Record<PluginName, PrettierPlugin>
  for (const name of PLUGIN_NAMES) {
    const source = await fetchText(pluginUrl(name))
    evaluateUmd(source, sandbox)
    const registry = sandbox.prettierPlugins
    const plugin = isRecord(registry) ? registry[name] : undefined
    if (!isRecord(plugin)) {
      throw new Error(`Prettier 插件 ${name} 初始化失败`)
    }
    plugins[name] = plugin
  }
  onProgress(0.9)
  return {
    prettier: {
      version: detectedVersion,
      format: prettier.format as PrettierApi['format'],
      check: prettier.check as PrettierApi['check'],
    },
    plugins,
  }
}

const ensureBundle = async (onProgress: RuntimeProgress): Promise<PrettierBundle> => {
  if (loadedBundle) {
    onProgress(1)
    return loadedBundle
  }
  if (loadingBundle) {
    const bundle = await loadingBundle
    onProgress(1)
    return bundle
  }
  const pending = createBundle(onProgress)
  loadingBundle = pending
  try {
    const bundle = await pending
    loadedBundle = bundle
    onProgress(1)
    return bundle
  } finally {
    loadingBundle = null
  }
}

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

const parserForExtension = (path: string): ResolvedParser | null => {
  switch (extensionOf(path)) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return { parser: 'typescript', plugins: ['estree', 'typescript'] }
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return { parser: 'babel', plugins: ['estree', 'babel'] }
    case '.json':
      return { parser: 'json', plugins: ['estree', 'babel'] }
    case '.css':
      return { parser: 'css', plugins: ['postcss'] }
    case '.scss':
      return { parser: 'scss', plugins: ['postcss'] }
    case '.md':
    case '.markdown':
      return { parser: 'markdown', plugins: ['markdown'] }
    case '.yaml':
    case '.yml':
      return { parser: 'yaml', plugins: ['yaml'] }
    default:
      return null
  }
}

/** 用户写 --parser=postcss 时，再按扩展名落到真正存在的 css/scss/less parser */
const parserForName = (value: string, path: string): ResolvedParser | null => {
  const name = value.toLowerCase()
  if (name === 'postcss') {
    const extension = extensionOf(path)
    if (extension === '.scss') {
      return { parser: 'scss', plugins: ['postcss'] }
    }
    if (extension === '.less') {
      return { parser: 'less', plugins: ['postcss'] }
    }
    return { parser: 'css', plugins: ['postcss'] }
  }
  if (name === 'css' || name === 'scss' || name === 'less') {
    return { parser: name, plugins: ['postcss'] }
  }
  if (name === 'babel' || name === 'json') {
    return { parser: name, plugins: ['estree', 'babel'] }
  }
  if (name === 'typescript') {
    return { parser: 'typescript', plugins: ['estree', 'typescript'] }
  }
  if (name === 'markdown') {
    return { parser: 'markdown', plugins: ['markdown'] }
  }
  if (name === 'yaml') {
    return { parser: 'yaml', plugins: ['yaml'] }
  }
  return null
}

/** 解析命令行；argv 不含命令名 */
const parseInvocation = (argv: string[]): PrettierInvocation => {
  const out: PrettierInvocation = {
    mode: 'run',
    files: [],
    write: false,
    check: false,
    parser: null,
    printWidth: 80,
    singleQuote: false,
  }
  const fail = (message: string): PrettierInvocation => ({ ...out, mode: 'error', message })
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === undefined) {
      break
    }
    if (arg === '--') {
      out.files.push(...argv.slice(index + 1))
      break
    }
    if (arg === '--version' || arg === '-v') {
      return { ...out, mode: 'version' }
    }
    if (arg === '--help' || arg === '-h') {
      return { ...out, mode: 'help' }
    }
    if (!arg.startsWith('-') || arg === '-') {
      out.files.push(arg)
      index += 1
      continue
    }
    if (!arg.startsWith('--')) {
      return fail(`prettier: 无法识别的选项 '${arg}'\n${USAGE}`)
    }

    const body = arg.slice(2)
    const equals = body.indexOf('=')
    const name = equals >= 0 ? body.slice(0, equals) : body
    const inlineValue = equals >= 0 ? body.slice(equals + 1) : null
    if (
      name === 'write' ||
      name === 'check' ||
      name === 'single-quote' ||
      name === 'no-single-quote'
    ) {
      if (inlineValue !== null) {
        return fail(`prettier: --${name} 是开关，不接受值 '${inlineValue}'\n`)
      }
      if (name === 'write') {
        out.write = true
      } else if (name === 'check') {
        out.check = true
      } else {
        out.singleQuote = name === 'single-quote'
      }
      index += 1
      continue
    }

    if (name !== 'parser' && name !== 'print-width') {
      return fail(`prettier: 无法识别的选项 '${arg}'\n${USAGE}`)
    }
    let value = inlineValue
    if (value === null) {
      const next = argv[index + 1]
      if (next === undefined) {
        return fail(`prettier: --${name} 需要一个值\n`)
      }
      value = next
      index += 1
    }
    if (name === 'parser') {
      if (value === '') {
        return fail('prettier: --parser 需要一个非空值\n')
      }
      out.parser = value
    } else {
      const width = Number(value)
      if (!Number.isInteger(width) || width <= 0) {
        return fail(`prettier: --print-width 需要正整数（收到 '${value}'）\n`)
      }
      out.printWidth = width
    }
    index += 1
  }
  if (out.write && out.check) {
    return fail('prettier: --write 与 --check 不能同时使用\n')
  }
  if (out.files.length === 0) {
    return fail(`prettier: 缺少输入文件\n${USAGE}`)
  }
  return out
}

const readFile = (io: RuntimeIO, display: string): { path: string; source: string } | null => {
  const path = resolvePath(io.cwd, display)
  const stat = io.fs.stat(path)
  if (!stat) {
    io.stderr(`prettier: 找不到文件 '${display}'\n`)
    return null
  }
  if (stat.kind === 'dir') {
    io.stderr(`prettier: '${display}' 是一个目录\n`)
    return null
  }
  let source: string | null
  try {
    source = io.fs.readText(path)
  } catch (error) {
    io.stderr(`prettier: 读取 '${display}' 失败：${errorText(error)}\n`)
    return null
  }
  if (source === null) {
    io.stderr(`prettier: 找不到文件 '${display}'\n`)
    return null
  }
  return { path, source }
}

const writeOutput = (io: RuntimeIO, path: string, text: string): boolean => {
  try {
    io.fs.mkdir(dirName(path), true)
    io.fs.writeText(path, text)
    return true
  } catch (error) {
    io.stderr(`prettier: 写入 ${path} 失败：${errorText(error)}\n`)
    return false
  }
}

const runPrettier = async (argv: string[], io: RuntimeIO): Promise<{ code: number }> => {
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  const invocation = parseInvocation(argv)
  if (invocation.mode === 'version') {
    io.stdout(`${detectedVersion}\n`)
    return { code: 0 }
  }
  if (invocation.mode === 'help') {
    io.stdout(USAGE)
    return { code: 0 }
  }
  if (invocation.mode === 'error') {
    io.stderr(invocation.message ?? 'prettier: 参数错误\n')
    return { code: 1 }
  }

  let bundle: PrettierBundle
  try {
    bundle = await ensureBundle(() => undefined)
  } catch (error) {
    io.stderr(
      `prettier: Prettier 运行时加载失败，需要联网（首次安装约 2MB）：${errorText(error)}\n` +
        '提示：连上网后执行 vm install prettier，装好之后本页内可复用。\n'
    )
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  // 先读文件并按扩展名确定 parser，任何一项失败都不写回，避免半途而废
  const plans: { display: string; path: string; source: string; parser: ResolvedParser }[] = []
  for (const display of invocation.files) {
    if (io.signal?.aborted) {
      return { code: 130 }
    }
    const parser = invocation.parser
      ? parserForName(invocation.parser, display)
      : parserForExtension(display)
    if (!parser) {
      const hint = invocation.parser
        ? `不支持的 parser '${invocation.parser}'`
        : `无法从扩展名推断解析器 '${display}'`
      io.stderr(`prettier: ${hint}，请用 --parser=babel|typescript|postcss|json|markdown|yaml\n`)
      return { code: 1 }
    }
    const read = readFile(io, display)
    if (!read) {
      return { code: 1 }
    }
    plans.push({ display, path: read.path, source: read.source, parser })
  }

  const results: {
    display: string
    path: string
    source: string
    formatted: string
    elapsed: number
  }[] = []
  for (const plan of plans) {
    if (io.signal?.aborted) {
      return { code: 130 }
    }
    const pluginList = plan.parser.plugins.map((name) => bundle.plugins[name])
    const options: Record<string, unknown> = {
      parser: plan.parser.parser,
      plugins: pluginList,
      printWidth: invocation.printWidth,
      singleQuote: invocation.singleQuote,
    }
    const started = Date.now()
    let formatted: string
    try {
      formatted = await bundle.prettier.format(plan.source, options)
    } catch (error) {
      io.stderr(`prettier: ${plan.display}: ${errorText(error)}\n`)
      return { code: 1 }
    }
    results.push({
      display: plan.display,
      path: plan.path,
      source: plan.source,
      formatted,
      elapsed: Date.now() - started,
    })
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  if (invocation.check) {
    const issues = results.filter((result) => result.formatted !== result.source)
    for (const issue of issues) {
      io.stdout(`[warn] ${issue.display}\n`)
    }
    if (issues.length === 0) {
      io.stdout('All matched files use Prettier code style!\n')
      return { code: 0 }
    }
    io.stdout('Code style issues found in the above file(s). Forgot to run Prettier?\n')
    return { code: 1 }
  }

  if (invocation.write) {
    for (const result of results) {
      if (io.signal?.aborted) {
        return { code: 130 }
      }
      if (!writeOutput(io, result.path, result.formatted)) {
        return { code: 1 }
      }
      io.stdout(`${result.display} ${result.elapsed}ms\n`)
    }
    return { code: 0 }
  }

  const multiple = results.length > 1
  const pieces = results.map((result) => {
    const code = result.formatted.endsWith('\n') ? result.formatted : `${result.formatted}\n`
    return multiple ? `// --- ${result.display} ---\n${code}` : code
  })
  io.stdout(pieces.join('\n'))
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  return { code: 0 }
}

/** Prettier 3.10（standalone + 六个语言插件，按 parser 使用） */
export const prettierRuntime: RuntimeModule = {
  load: async (onProgress) => {
    const bundle = await ensureBundle(onProgress)
    return { version: bundle.prettier.version }
  },
  run: async (argv, io) => {
    try {
      return await runPrettier(argv, io)
    } catch (error) {
      io.stderr(`prettier: ${errorText(error)}\n`)
      return { code: 1 }
    }
  },
  dispose: () => {
    loadedBundle = null
    loadingBundle = null
    detectedVersion = FALLBACK_VERSION
  },
}
