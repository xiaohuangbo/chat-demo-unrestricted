import { baseName, dirName, resolvePath } from '../fs.js'
import type { RuntimeIO, RuntimeModule, RuntimeProgress } from './types.js'

/**
 * Terser（官方 JS 压缩器）浏览器运行时。
 *
 * 从 jsDelivr 取 `dist/bundle.min.js`（UMD，约 1.1MB）。这个 bundle 把
 * `@jridgewell/source-map` 留成外部依赖（浏览器里读 `global.sourceMap`），
 * 所以 `--source-map` 还需要按顺序加载 @jridgewell 的五个 UMD 小文件：
 * resolve-uri → sourcemap-codec → trace-mapping → gen-mapping → source-map。
 * 六个文件都写进 Cache Storage（`nanovm-terser-cache`）。
 *
 * 所有 UMD 都通过 `new Function('globalThis', 'module', 'exports', 'define', ...)`
 * 在一个继承自 window 的沙箱对象里执行：UMD 的 `this` 与 `globalThis` 都指向
 * 沙箱，因此既能让 source-map 的 UMD 正确拿到 genMapping/traceMapping，又不会
 * 往页面全局写 `Terser` / `sourceMap`。最后从沙箱取 `Terser.minify`。
 *
 * 命令支持：`-c` 压缩、`-m` 变量重命名、`-o` 输出、`--source-map`
 * （写文件时生成 .map，写 stdout 时内联）、`--comments=false`。
 */

const TERSER_URL = 'https://cdn.jsdelivr.net/npm/terser@5.51.2/dist/bundle.min.js'
const CACHE_NAME = 'nanovm-terser-cache'
const FALLBACK_VERSION = '5.51.2'

/** source-map 依赖的加载顺序：后面的 UMD 依赖前面的全局名 */
const SOURCE_MAP_ASSETS = [
  {
    url: 'https://cdn.jsdelivr.net/npm/@jridgewell/resolve-uri@3.1.2/dist/resolve-uri.umd.js',
    globalName: 'resolveURI',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/@jridgewell/sourcemap-codec@1.5.5/dist/sourcemap-codec.umd.js',
    globalName: 'sourcemapCodec',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/@jridgewell/trace-mapping@0.3.31/dist/trace-mapping.umd.js',
    globalName: 'traceMapping',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/@jridgewell/gen-mapping@0.3.13/dist/gen-mapping.umd.js',
    globalName: 'genMapping',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/@jridgewell/source-map@0.3.11/dist/source-map.umd.js',
    globalName: 'sourceMap',
  },
] as const

type TerserErrorLike = Error & {
  filename?: string | number
  line?: number
  col?: number
  pos?: number
}

type TerserOptions = {
  compress?: boolean | Record<string, unknown>
  mangle?: boolean | Record<string, unknown>
  format?: Record<string, unknown>
  sourceMap?: boolean | Record<string, unknown>
}

type TerserResult = {
  code?: string
  map?: string
  error?: TerserErrorLike
}

type TerserApi = {
  minify: (input: string | Record<string, string>, options: TerserOptions) => Promise<TerserResult>
}

type TerserMode = 'version' | 'help' | 'error' | 'run'

type TerserInvocation = {
  mode: TerserMode
  files: string[]
  compress: boolean
  mangle: boolean
  output: string | null
  sourceMap: boolean
  comments: boolean | null
  message?: string
}

type Sandbox = Record<string, unknown>

const USAGE = [
  '用法：terser 输入.js [更多输入.js] [选项]',
  '',
  '  -c, --compress        启用压缩（删除死代码、简化表达式）',
  '  -m, --mangle          重命名局部变量',
  '  -o, --output=文件     输出文件（省略时写标准输出）',
  '      --source-map      生成 sourcemap：写文件时 .map，写 stdout 时内联',
  '      --comments=false  去掉所有注释（true 保留；默认按 terser 规则保留 license）',
  '  -v, --version         显示版本',
  '  -h, --help            显示本说明',
  '',
  '多个输入会按命令行顺序拼成一个文件再压缩。',
  '',
].join('\n')

let loadedApi: TerserApi | null = null
let loadingApi: Promise<TerserApi> | null = null
let detectedVersion = FALLBACK_VERSION

const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
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

/**
 * 在沙箱里执行 UMD。
 * `this` 与参数 `globalThis` 都指向 sandbox：source-map 的 UMD 会从 `this`
 * 读 genMapping/traceMapping，而 Terser 会从 `globalThis` 读 sourceMap。
 */
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

const createApi = async (onProgress: RuntimeProgress): Promise<TerserApi> => {
  onProgress(0.1)
  const terserSource = await fetchText(TERSER_URL)
  onProgress(0.6)
  const sources: string[] = []
  for (const asset of SOURCE_MAP_ASSETS) {
    sources.push(await fetchText(asset.url))
  }
  onProgress(0.9)

  const sandbox = createSandbox()
  for (let index = 0; index < SOURCE_MAP_ASSETS.length; index += 1) {
    const asset = SOURCE_MAP_ASSETS[index]
    const source = sources[index]
    if (!asset || source === undefined) {
      throw new Error('Terser 的 source-map 依赖加载不完整')
    }
    evaluateUmd(source, sandbox)
    if (!isRecord(sandbox[asset.globalName])) {
      throw new Error(`Terser 的 source-map 依赖 ${asset.globalName} 初始化失败`)
    }
  }
  evaluateUmd(terserSource, sandbox)
  const value = sandbox.Terser
  if (!isRecord(value) || typeof value.minify !== 'function') {
    throw new Error('Terser 模块格式异常：缺少 minify 导出')
  }
  onProgress(1)
  return { minify: value.minify as TerserApi['minify'] }
}

const ensureApi = async (onProgress: RuntimeProgress): Promise<TerserApi> => {
  if (loadedApi) {
    onProgress(1)
    return loadedApi
  }
  if (loadingApi) {
    const api = await loadingApi
    onProgress(1)
    return api
  }
  const pending = createApi(onProgress)
  loadingApi = pending
  try {
    const api = await pending
    loadedApi = api
    return api
  } finally {
    loadingApi = null
  }
}

/** 解析命令行；argv 不含命令名 */
const parseInvocation = (argv: string[]): TerserInvocation => {
  const out: TerserInvocation = {
    mode: 'run',
    files: [],
    compress: false,
    mangle: false,
    output: null,
    sourceMap: false,
    comments: null,
  }
  const fail = (message: string): TerserInvocation => ({ ...out, mode: 'error', message })
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
      if (arg === '-o') {
        const next = argv[index + 1]
        if (next === undefined) {
          return fail('terser: -o 需要一个输出文件\n')
        }
        out.output = next
        index += 2
        continue
      }
      if (/^-[cm]+$/.test(arg)) {
        for (const flag of arg.slice(1)) {
          if (flag === 'c') {
            out.compress = true
          } else {
            out.mangle = true
          }
        }
        index += 1
        continue
      }
      return fail(`terser: 无法识别的选项 '${arg}'\n${USAGE}`)
    }

    const body = arg.slice(2)
    const equals = body.indexOf('=')
    const name = equals >= 0 ? body.slice(0, equals) : body
    const inlineValue = equals >= 0 ? body.slice(equals + 1) : null
    if (name === 'compress' || name === 'mangle' || name === 'source-map') {
      if (inlineValue !== null) {
        return fail(`terser: --${name} 是开关，不接受值 '${inlineValue}'\n`)
      }
      if (name === 'compress') {
        out.compress = true
      } else if (name === 'mangle') {
        out.mangle = true
      } else {
        out.sourceMap = true
      }
      index += 1
      continue
    }
    if (name === 'comments') {
      let value = inlineValue
      if (value === null) {
        const next = argv[index + 1]
        if (next === 'true' || next === 'false') {
          value = next
          index += 1
        }
      }
      if (value === null) {
        out.comments = true
      } else if (value === 'true') {
        out.comments = true
      } else if (value === 'false') {
        out.comments = false
      } else {
        return fail(`terser: --comments 只支持 true / false（收到 '${value}'）\n`)
      }
      index += 1
      continue
    }
    if (name === 'output') {
      let value = inlineValue
      if (value === null) {
        const next = argv[index + 1]
        if (next === undefined) {
          return fail('terser: --output 需要一个输出文件\n')
        }
        value = next
        index += 1
      }
      if (value === '') {
        return fail('terser: --output 需要一个非空路径\n')
      }
      out.output = value
      index += 1
      continue
    }
    return fail(`terser: 无法识别的选项 '${arg}'\n${USAGE}`)
  }
  if (out.files.length === 0) {
    return fail(`terser: 缺少输入文件\n${USAGE}`)
  }
  return out
}

const readInputs = (io: RuntimeIO, files: string[]): Record<string, string> | null => {
  const input: Record<string, string> = {}
  for (const display of files) {
    if (io.signal?.aborted) {
      return null
    }
    if (Object.prototype.hasOwnProperty.call(input, display)) {
      io.stderr(`terser: 重复的输入文件 '${display}'\n`)
      return null
    }
    const path = resolvePath(io.cwd, display)
    const stat = io.fs.stat(path)
    if (!stat) {
      io.stderr(`terser: 找不到文件 '${display}'\n`)
      return null
    }
    if (stat.kind === 'dir') {
      io.stderr(`terser: '${display}' 是一个目录\n`)
      return null
    }
    let source: string | null
    try {
      source = io.fs.readText(path)
    } catch (error) {
      io.stderr(`terser: 读取 '${display}' 失败：${errorText(error)}\n`)
      return null
    }
    if (source === null) {
      io.stderr(`terser: 找不到文件 '${display}'\n`)
      return null
    }
    input[display] = source
  }
  return input
}

const formatError = (io: RuntimeIO, error: TerserErrorLike, fallback: string): void => {
  const file =
    typeof error.filename === 'string' && error.filename !== '0' ? error.filename : fallback
  const line = typeof error.line === 'number' ? error.line : 1
  const column = typeof error.col === 'number' ? error.col + 1 : 1
  io.stderr(`terser: ${file}:${line}:${column}: ${errorText(error)}\n`)
}

const writeOutput = (io: RuntimeIO, path: string, text: string): boolean => {
  try {
    io.fs.mkdir(dirName(path), true)
    io.fs.writeText(path, text)
    return true
  } catch (error) {
    io.stderr(`terser: 写入 ${path} 失败：${errorText(error)}\n`)
    return false
  }
}

const runTerser = async (argv: string[], io: RuntimeIO): Promise<{ code: number }> => {
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  const invocation = parseInvocation(argv)
  if (invocation.mode === 'version') {
    io.stdout(`terser ${detectedVersion}\n`)
    return { code: 0 }
  }
  if (invocation.mode === 'help') {
    io.stdout(USAGE)
    return { code: 0 }
  }
  if (invocation.mode === 'error') {
    io.stderr(invocation.message ?? 'terser: 参数错误\n')
    return { code: 1 }
  }

  let api: TerserApi
  try {
    api = await ensureApi(() => undefined)
  } catch (error) {
    io.stderr(
      `terser: Terser 运行时加载失败，需要联网（首次安装约 1.1MB）：${errorText(error)}\n` +
        '提示：连上网后执行 vm install terser，装好之后本页内可复用。\n'
    )
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  const input = readInputs(io, invocation.files)
  if (!input) {
    return { code: io.signal?.aborted ? 130 : 1 }
  }

  const outputPath = invocation.output === null ? null : resolvePath(io.cwd, invocation.output)
  const options: TerserOptions = {}
  if (invocation.compress) {
    options.compress = true
  }
  if (invocation.mangle) {
    options.mangle = true
  }
  if (invocation.comments !== null) {
    options.format = { comments: invocation.comments }
  }
  if (invocation.sourceMap) {
    options.sourceMap =
      outputPath === null
        ? { url: 'inline' }
        : { filename: baseName(outputPath), url: `${baseName(outputPath)}.map` }
  }

  let result: TerserResult
  try {
    result = await api.minify(input, options)
  } catch (error) {
    const detail = error instanceof Error ? (error as TerserErrorLike) : new Error(errorText(error))
    formatError(io, detail, invocation.files[0] ?? 'input.js')
    return { code: 1 }
  }
  if (result.error) {
    formatError(io, result.error, invocation.files[0] ?? 'input.js')
    return { code: 1 }
  }
  if (typeof result.code !== 'string') {
    io.stderr('terser: 压缩没有返回代码\n')
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  const code = result.code.endsWith('\n') ? result.code : `${result.code}\n`
  if (outputPath === null) {
    io.stdout(code)
  } else {
    if (!writeOutput(io, outputPath, code)) {
      return { code: 1 }
    }
    if (invocation.sourceMap) {
      if (typeof result.map === 'string') {
        if (!writeOutput(io, `${outputPath}.map`, result.map)) {
          return { code: 1 }
        }
      } else {
        io.stderr('terser: 编译器没有返回 source map，已只写 JS\n')
      }
    }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  return { code: 0 }
}

/** Terser 5.51（UMD bundle + @jridgewell/source-map 依赖） */
export const terserRuntime: RuntimeModule = {
  load: async (onProgress) => {
    await ensureApi(onProgress)
    return { version: detectedVersion }
  },
  run: async (argv, io) => {
    try {
      return await runTerser(argv, io)
    } catch (error) {
      io.stderr(`terser: ${errorText(error)}\n`)
      return { code: 1 }
    }
  },
  dispose: () => {
    loadedApi = null
    loadingApi = null
    detectedVersion = FALLBACK_VERSION
  },
}
