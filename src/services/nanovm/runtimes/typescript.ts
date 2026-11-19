import { baseName, dirName, resolvePath } from '../fs.js'
import type { RuntimeIO, RuntimeModule, RuntimeProgress } from './types.js'

/**
 * TypeScript 官方编译器运行时（浏览器版 tsc）。
 *
 * 从 jsDelivr 下载单文件 UMD 构建 `lib/typescript.js`（约 8.7MB）。文本优先放进
 * Cache Storage（`nanovm-typescript-cache`，key 就是 URL），下次安装直接命中；
 * 缓存不可用时回落到重新 fetch。拿到文本后用 `new Function` 在函数作用域里执行：
 * UMD 顶部的 `var ts = {}` 因此只存在于函数内部，不会污染页面的全局 `ts`，
 * 函数返回编译器对象即可。
 *
 * 命令用 `ts.transpileModule` 逐文件转译，**只做语法解析、不做类型检查**；
 * `--noEmit` 仍然走一遍解析以便报语法错误。`--declaration` 用 5.9 提供的
 * `transpileDeclaration` 生成 .d.ts，缺少该 API 时会在 stderr 说明并跳过。
 *
 * 输出约定：
 * - `--outfile` 只允许一个入口；`--outdir` 按 cwd 相对路径保留子目录；
 * - 都没给时写 stdout，多入口用 `// --- 文件 ---` 分隔；
 * - `--sourceMap` 写文件时生成同名 .map 并补 `//# sourceMappingURL=`，
 *   写 stdout 时改写成内联 data URL（否则会指向一个不存在的文件）。
 */

const TYPESCRIPT_URL = 'https://cdn.jsdelivr.net/npm/typescript@5.9.2/lib/typescript.js'
const CACHE_NAME = 'nanovm-typescript-cache'
const FALLBACK_VERSION = '5.9.2'

const DEFAULT_TARGET = 'ES2020'
const DEFAULT_MODULE = 'ESNext'

/** tsc 的诊断信息；只声明用到的字段，避免把整个 typescript 类型拖进 bundle */
type TsDiagnosticMessage =
  | string
  | {
      messageText: TsDiagnosticMessage
      next?: TsDiagnosticMessage[]
    }

type TsSourceFileLike = {
  fileName: string
  getLineAndCharacterOfPosition: (position: number) => { line: number; character: number }
}

type TsDiagnostic = {
  code: number
  category?: number
  file?: TsSourceFileLike
  start?: number
  messageText: TsDiagnosticMessage
}

type TsTranspileOptions = {
  compilerOptions: Record<string, unknown>
  fileName: string
  reportDiagnostics?: boolean
}

type TsTranspileResult = {
  outputText: string
  sourceMapText?: string
  diagnostics?: TsDiagnostic[]
}

type TsCompiler = {
  version: string
  ScriptTarget: Record<string, number>
  ModuleKind: Record<string, number>
  JsxEmit: Record<string, number>
  transpileModule: (input: string, options: TsTranspileOptions) => TsTranspileResult
  transpileDeclaration?: (input: string, options: TsTranspileOptions) => TsTranspileResult
}

type TscMode = 'version' | 'help' | 'error' | 'run'

type TscInvocation = {
  mode: TscMode
  files: string[]
  outfile: string | null
  outdir: string | null
  target: string
  module: string
  jsx: string | null
  sourceMap: boolean
  declaration: boolean
  noEmit: boolean
  strict: boolean
  message?: string
}

/** 单个入口的转译结果，写文件 / 写 stdout 都从这里取 */
type TscOutput = {
  /** 命令行里原样的输入路径，用于诊断与分隔标题 */
  display: string
  /** VFS 里的绝对路径 */
  path: string
  code: string
  map: string | null
  declaration: string | null
  declarationName: string
}

const USAGE = [
  '用法：tsc [选项] 文件...',
  '',
  '  --outfile=文件        输出到单个文件（--outfile 只支持单个入口文件）',
  '  --outdir=目录         输出到目录（可多个入口，保留相对子目录）',
  '  --target=ES2020       目标语法版本（默认 ES2020）',
  '  --module=ESNext       模块格式 ESNext / CommonJS 等（默认 ESNext）',
  '  --jsx=react|react-jsx|preserve',
  '  --sourceMap           生成 .map；写 stdout 时改成内联 source map',
  '  --declaration         额外生成 .d.ts',
  '  --noEmit              只做语法解析，不写任何文件',
  '  --strict              打开 strict 编译选项（仍然不做类型检查）',
  '  -v, --version         显示版本',
  '  -h, --help            显示本说明',
  '',
  '注意：这里用 transpileModule 逐文件转译，只做语法解析，不做类型检查。',
  '      需要类型检查请在本机用完整 tsc；本运行时面向浏览器里的快速转译。',
  '',
].join('\n')

const TARGET_ALIASES: Record<string, string> = {
  es3: 'ES3',
  es5: 'ES5',
  es6: 'ES2015',
  es2015: 'ES2015',
  es2016: 'ES2016',
  es2017: 'ES2017',
  es2018: 'ES2018',
  es2019: 'ES2019',
  es2020: 'ES2020',
  es2021: 'ES2021',
  es2022: 'ES2022',
  es2023: 'ES2023',
  es2024: 'ES2024',
  esnext: 'ESNext',
  latest: 'ESNext',
}

const MODULE_ALIASES: Record<string, string> = {
  none: 'None',
  commonjs: 'CommonJS',
  cjs: 'CommonJS',
  amd: 'AMD',
  umd: 'UMD',
  system: 'System',
  es2015: 'ES2015',
  es6: 'ES2015',
  es2020: 'ES2020',
  es2022: 'ES2022',
  esnext: 'ESNext',
  node16: 'Node16',
  node18: 'Node18',
  node20: 'Node20',
  nodenext: 'NodeNext',
  preserve: 'Preserve',
}

const JSX_ALIASES: Record<string, string> = {
  react: 'React',
  'react-jsx': 'ReactJSX',
  'react-jsxdev': 'ReactJSXDev',
  'react-native': 'ReactNative',
  preserve: 'Preserve',
}

let loadedCompiler: TsCompiler | null = null
let loadingCompiler: Promise<TsCompiler> | null = null
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

/** 下载并缓存编译器文本；缓存不可用时直接重新 fetch */
const fetchCompilerText = async (): Promise<string> => {
  const cached = await readCachedText(TYPESCRIPT_URL)
  if (cached !== null) {
    return cached
  }
  let response: Response
  try {
    response = await fetch(TYPESCRIPT_URL)
  } catch (error) {
    throw new Error(`TypeScript 编译器下载失败，请检查网络：${errorText(error)}`)
  }
  if (!response.ok) {
    throw new Error(`TypeScript 编译器下载失败：HTTP ${response.status}`)
  }
  const source = await response.text()
  await writeCachedText(TYPESCRIPT_URL, source)
  return source
}

/** 校验编译器对象形状；UMD 里的 `ts` 是函数作用域变量，不会泄漏到 window */
const evaluateCompiler = (source: string): TsCompiler => {
  let value: unknown
  try {
    // 末尾的 return 让函数返回 UMD 定义的 ts；顶部的 var ts 只存活在函数作用域里
    const factory = new Function('source', `${source}\n;return ts;`) as (input: string) => unknown
    value = factory(source)
  } catch (error) {
    throw new Error(`TypeScript 编译器初始化失败：${errorText(error)}`)
  }
  if (!isRecord(value)) {
    throw new Error('TypeScript 编译器初始化失败：没有拿到编译器对象')
  }
  if (typeof value.version !== 'string' || typeof value.transpileModule !== 'function') {
    throw new Error('TypeScript 编译器格式异常：缺少 version / transpileModule')
  }
  if (!isRecord(value.ScriptTarget) || !isRecord(value.ModuleKind) || !isRecord(value.JsxEmit)) {
    throw new Error('TypeScript 编译器格式异常：缺少 ScriptTarget / ModuleKind / JsxEmit')
  }
  return {
    version: value.version,
    ScriptTarget: value.ScriptTarget as Record<string, number>,
    ModuleKind: value.ModuleKind as Record<string, number>,
    JsxEmit: value.JsxEmit as Record<string, number>,
    transpileModule: value.transpileModule as TsCompiler['transpileModule'],
    transpileDeclaration:
      typeof value.transpileDeclaration === 'function'
        ? (value.transpileDeclaration as TsCompiler['transpileDeclaration'])
        : undefined,
  }
}

const createCompiler = async (onProgress: RuntimeProgress): Promise<TsCompiler> => {
  onProgress(0.1)
  const source = await fetchCompilerText()
  onProgress(0.6)
  const compiler = evaluateCompiler(source)
  detectedVersion = compiler.version || FALLBACK_VERSION
  onProgress(0.9)
  return compiler
}

/** 取编译器；并发调用共用同一个加载 Promise */
const ensureCompiler = async (onProgress: RuntimeProgress): Promise<TsCompiler> => {
  if (loadedCompiler) {
    onProgress(1)
    return loadedCompiler
  }
  if (loadingCompiler) {
    const compiler = await loadingCompiler
    onProgress(1)
    return compiler
  }
  const pending = createCompiler(onProgress)
  loadingCompiler = pending
  try {
    const compiler = await pending
    loadedCompiler = compiler
    onProgress(1)
    return compiler
  } finally {
    loadingCompiler = null
  }
}

const asTarget = (value: string): string | null => TARGET_ALIASES[value.toLowerCase()] ?? null

const asModule = (value: string): string | null => MODULE_ALIASES[value.toLowerCase()] ?? null

const asJsx = (value: string): string | null => JSX_ALIASES[value.toLowerCase()] ?? null

const fail = (invocation: TscInvocation, message: string): TscInvocation => ({
  ...invocation,
  mode: 'error',
  message,
})

/** 解析命令行；argv 不含命令名 */
const parseInvocation = (argv: string[]): TscInvocation => {
  const out: TscInvocation = {
    mode: 'run',
    files: [],
    outfile: null,
    outdir: null,
    target: DEFAULT_TARGET,
    module: DEFAULT_MODULE,
    jsx: null,
    sourceMap: false,
    declaration: false,
    noEmit: false,
    strict: false,
  }
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
    if (!arg.startsWith('-')) {
      out.files.push(arg)
      index += 1
      continue
    }
    if (!arg.startsWith('--')) {
      return fail(out, `tsc: 无法识别的选项 '${arg}'\n${USAGE}`)
    }

    const body = arg.slice(2)
    const equals = body.indexOf('=')
    const name = equals >= 0 ? body.slice(0, equals) : body
    const inlineValue = equals >= 0 ? body.slice(equals + 1) : null
    const normalized = name.toLowerCase()

    if (
      normalized === 'sourcemap' ||
      normalized === 'declaration' ||
      normalized === 'noemit' ||
      normalized === 'strict'
    ) {
      if (inlineValue !== null) {
        return fail(out, `tsc: --${name} 是开关，不接受值 '${inlineValue}'\n`)
      }
      if (normalized === 'sourcemap') {
        out.sourceMap = true
      } else if (normalized === 'declaration') {
        out.declaration = true
      } else if (normalized === 'noemit') {
        out.noEmit = true
      } else {
        out.strict = true
      }
      index += 1
      continue
    }

    const valueOptions = ['outfile', 'outdir', 'target', 'module', 'jsx']
    if (!valueOptions.includes(normalized)) {
      return fail(out, `tsc: 无法识别的选项 '${arg}'\n${USAGE}`)
    }
    let value = inlineValue
    if (value === null) {
      const next = argv[index + 1]
      if (next === undefined) {
        return fail(out, `tsc: --${name} 需要一个值\n`)
      }
      value = next
      index += 1
    }
    if (value === '') {
      return fail(out, `tsc: --${name} 需要一个非空值\n`)
    }
    if (normalized === 'outfile') {
      out.outfile = value
    } else if (normalized === 'outdir') {
      out.outdir = value
    } else if (normalized === 'target') {
      const target = asTarget(value)
      if (!target) {
        return fail(out, `tsc: 不支持的 target '${value}'\n`)
      }
      out.target = target
    } else if (normalized === 'module') {
      const module = asModule(value)
      if (!module) {
        return fail(out, `tsc: 不支持的 module '${value}'\n`)
      }
      out.module = module
    } else {
      const jsx = asJsx(value)
      if (!jsx) {
        return fail(out, `tsc: 不支持的 jsx '${value}'（可用 react / react-jsx / preserve）\n`)
      }
      out.jsx = jsx
    }
    index += 1
  }

  if (out.outfile !== null && out.outdir !== null) {
    return fail(out, 'tsc: --outfile 与 --outdir 不能同时使用\n')
  }
  if (out.outfile !== null && out.files.length > 1) {
    return fail(out, 'tsc: --outfile 只支持单个入口文件\n')
  }
  if (out.files.length === 0) {
    return fail(out, `tsc: 缺少输入文件\n${USAGE}`)
  }
  return out
}

const extensionOf = (path: string): string => {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

const stripExtension = (path: string): string => {
  const extension = extensionOf(path)
  return extension ? path.slice(0, path.length - extension.length) : path
}

const jsExtensionFor = (inputPath: string): string => {
  const extension = extensionOf(inputPath)
  if (extension === '.mts') {
    return '.mjs'
  }
  if (extension === '.cts') {
    return '.cjs'
  }
  return '.js'
}

const declarationExtensionFor = (path: string): string => {
  const extension = extensionOf(path)
  if (extension === '.mts' || extension === '.mjs') {
    return '.d.mts'
  }
  if (extension === '.cts' || extension === '.cjs') {
    return '.d.cts'
  }
  return '.d.ts'
}

/** 输入文件相对 cwd 的路径；在 cwd 外时退回文件名 */
const relativeToCwd = (cwd: string, path: string): string => {
  const prefix = cwd === '/' ? '/' : `${cwd}/`
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length)
  }
  return baseName(path)
}

const outputCodePath = (cwd: string, outdir: string, inputPath: string): string => {
  const relative = relativeToCwd(cwd, inputPath)
  return resolvePath(outdir, `${stripExtension(relative)}${jsExtensionFor(inputPath)}`)
}

const declarationPath = (cwd: string, outdir: string, inputPath: string): string => {
  const relative = relativeToCwd(cwd, inputPath)
  return resolvePath(outdir, `${stripExtension(relative)}${declarationExtensionFor(inputPath)}`)
}

const outputDeclarationPath = (outfile: string): string => {
  return `${stripExtension(outfile)}${declarationExtensionFor(outfile)}`
}

const readSource = (io: RuntimeIO, display: string): { path: string; source: string } | null => {
  const path = resolvePath(io.cwd, display)
  const stat = io.fs.stat(path)
  if (!stat) {
    io.stderr(`tsc: 找不到文件 '${display}'\n`)
    return null
  }
  if (stat.kind === 'dir') {
    io.stderr(`tsc: '${display}' 是一个目录\n`)
    return null
  }
  let source: string | null
  try {
    source = io.fs.readText(path)
  } catch (error) {
    io.stderr(`tsc: 读取 '${display}' 失败：${errorText(error)}\n`)
    return null
  }
  if (source === null) {
    io.stderr(`tsc: 找不到文件 '${display}'\n`)
    return null
  }
  return { path, source }
}

const flattenMessage = (message: TsDiagnosticMessage): string => {
  if (typeof message === 'string') {
    return message
  }
  const head = flattenMessage(message.messageText)
  if (message.next && message.next.length > 0) {
    return `${head} ${message.next.map(flattenMessage).join(' ')}`
  }
  return head
}

/** 把诊断写成 tsc 风格；返回是否存在错误 */
const reportDiagnostics = (
  io: RuntimeIO,
  fallbackFile: string,
  diagnostics: TsDiagnostic[]
): boolean => {
  let hasError = false
  for (const diagnostic of diagnostics) {
    hasError = true
    const file = diagnostic.file?.fileName ?? fallbackFile
    let line = 1
    let column = 1
    if (
      diagnostic.file !== undefined &&
      typeof diagnostic.start === 'number' &&
      typeof diagnostic.file.getLineAndCharacterOfPosition === 'function'
    ) {
      const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      line = location.line + 1
      column = location.character + 1
    }
    io.stderr(`tsc: ${file}:${line}:${column}: ${flattenMessage(diagnostic.messageText)}\n`)
  }
  return hasError
}

const stripSourceMapComment = (code: string): string => {
  return code.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, '')
}

const withSourceMapComment = (code: string, url: string): string => {
  const body = stripSourceMapComment(code)
  return `${body}${body.endsWith('\n') ? '' : '\n'}//# sourceMappingURL=${url}\n`
}

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

const inlineSourceMap = (map: string): string => {
  return `data:application/json;base64,${toBase64(map)}`
}

/** 修正 sourcemap 的 file / sources，让它们在 VFS 输出里也说得通 */
const fixSourceMap = (map: string, outputPath: string, sourcePath: string): string => {
  try {
    const parsed: unknown = JSON.parse(map)
    if (!isRecord(parsed)) {
      return map
    }
    parsed.file = baseName(outputPath)
    parsed.sources = [sourcePath]
    return JSON.stringify(parsed)
  } catch {
    return map
  }
}

const buildCompilerOptions = (
  compiler: TsCompiler,
  invocation: TscInvocation
): Record<string, unknown> => {
  const target = compiler.ScriptTarget[invocation.target]
  if (target === undefined) {
    throw new Error(`当前 TypeScript 版本不认识 target '${invocation.target}'`)
  }
  const module = compiler.ModuleKind[invocation.module]
  if (module === undefined) {
    throw new Error(`当前 TypeScript 版本不认识 module '${invocation.module}'`)
  }
  const options: Record<string, unknown> = {
    target,
    module,
    strict: invocation.strict,
  }
  if (invocation.sourceMap) {
    options.sourceMap = true
  }
  if (invocation.jsx !== null) {
    const jsx = compiler.JsxEmit[invocation.jsx]
    if (jsx === undefined) {
      throw new Error(`当前 TypeScript 版本不认识 jsx '${invocation.jsx}'`)
    }
    options.jsx = jsx
  }
  return options
}

const writeTextFile = (io: RuntimeIO, path: string, text: string): boolean => {
  try {
    io.fs.mkdir(dirName(path), true)
    io.fs.writeText(path, text)
    return true
  } catch (error) {
    io.stderr(`tsc: 写入 ${path} 失败：${errorText(error)}\n`)
    return false
  }
}

const buildDeclarations = (
  compiler: TsCompiler,
  invocation: TscInvocation,
  io: RuntimeIO,
  display: string,
  source: string,
  options: Record<string, unknown>
): { declaration: string | null; error: boolean } => {
  if (!invocation.declaration || invocation.noEmit) {
    return { declaration: null, error: false }
  }
  if (typeof compiler.transpileDeclaration !== 'function') {
    io.stderr(
      `tsc: TypeScript ${compiler.version} 不支持 transpileDeclaration，已跳过 .d.ts 生成\n`
    )
    return { declaration: null, error: false }
  }
  let result: TsTranspileResult
  try {
    result = compiler.transpileDeclaration(source, {
      compilerOptions: {
        ...options,
        sourceMap: false,
        declaration: true,
        emitDeclarationOnly: true,
      },
      fileName: display,
      reportDiagnostics: true,
    })
  } catch (error) {
    io.stderr(`tsc: 生成 '${display}' 的声明文件失败（${errorText(error)}），已跳过\n`)
    return { declaration: null, error: false }
  }
  const diagnostics = result.diagnostics ?? []
  if (reportDiagnostics(io, display, diagnostics)) {
    return { declaration: null, error: true }
  }
  return { declaration: result.outputText, error: false }
}

const collectOutput = (
  compiler: TsCompiler,
  invocation: TscInvocation,
  io: RuntimeIO
): TscOutput[] | null => {
  const options = buildCompilerOptions(compiler, invocation)
  const outputs: TscOutput[] = []
  for (const display of invocation.files) {
    if (io.signal?.aborted) {
      return null
    }
    const read = readSource(io, display)
    if (!read) {
      return null
    }
    let result: TsTranspileResult
    try {
      result = compiler.transpileModule(read.source, {
        compilerOptions: options,
        fileName: display,
        reportDiagnostics: true,
      })
    } catch (error) {
      io.stderr(`tsc: 转译 '${display}' 失败：${errorText(error)}\n`)
      return null
    }
    if (reportDiagnostics(io, display, result.diagnostics ?? [])) {
      return null
    }

    const declaration = buildDeclarations(compiler, invocation, io, display, read.source, options)
    if (declaration.error) {
      return null
    }
    outputs.push({
      display,
      path: read.path,
      code: stripSourceMapComment(result.outputText),
      map: invocation.sourceMap ? (result.sourceMapText ?? null) : null,
      declaration: declaration.declaration,
      declarationName: `${stripExtension(relativeToCwd(io.cwd, read.path))}${declarationExtensionFor(
        read.path
      )}`,
    })
  }
  return outputs
}

const writeSingleOutput = (
  io: RuntimeIO,
  invocation: TscInvocation,
  output: TscOutput
): boolean => {
  if (!invocation.outfile) {
    return false
  }
  const target = resolvePath(io.cwd, invocation.outfile)
  let code = output.code
  if (invocation.sourceMap) {
    if (output.map !== null) {
      const mapPath = `${target}.map`
      const fixed = fixSourceMap(output.map, target, output.display)
      if (!writeTextFile(io, mapPath, fixed)) {
        return false
      }
      code = withSourceMapComment(code, `${baseName(target)}.map`)
    } else {
      io.stderr('tsc: 编译器没有返回 source map，已只写 JS\n')
    }
  }
  if (!writeTextFile(io, target, code)) {
    return false
  }
  if (invocation.declaration && output.declaration !== null) {
    if (!writeTextFile(io, outputDeclarationPath(target), output.declaration)) {
      return false
    }
  }
  return true
}

const writeOutdirOutputs = (
  io: RuntimeIO,
  invocation: TscInvocation,
  outputs: TscOutput[]
): boolean => {
  if (!invocation.outdir) {
    return false
  }
  const outdir = resolvePath(io.cwd, invocation.outdir)
  const seen = new Set<string>()
  for (const output of outputs) {
    if (io.signal?.aborted) {
      return false
    }
    const target = outputCodePath(io.cwd, outdir, output.path)
    if (seen.has(target)) {
      io.stderr(`tsc: 输出文件冲突 '${target}'，请分开 --outdir\n`)
      return false
    }
    seen.add(target)
    let code = output.code
    if (invocation.sourceMap) {
      if (output.map !== null) {
        const fixed = fixSourceMap(output.map, target, output.display)
        if (!writeTextFile(io, `${target}.map`, fixed)) {
          return false
        }
        code = withSourceMapComment(code, `${baseName(target)}.map`)
      } else {
        io.stderr(`tsc: ${output.display} 没有返回 source map，已只写 JS\n`)
      }
    }
    if (!writeTextFile(io, target, code)) {
      return false
    }
    if (invocation.declaration && output.declaration !== null) {
      const declPath = declarationPath(io.cwd, outdir, output.path)
      if (!writeTextFile(io, declPath, output.declaration)) {
        return false
      }
    }
  }
  return true
}

const writeStdout = (io: RuntimeIO, invocation: TscInvocation, outputs: TscOutput[]): void => {
  const multiple = outputs.length > 1
  outputs.forEach((output, index) => {
    if (multiple) {
      io.stdout(`// --- ${output.display} ---\n`)
    }
    let code = output.code
    if (invocation.sourceMap && output.map !== null) {
      const virtual = outputCodePath(io.cwd, io.cwd, output.path)
      code = withSourceMapComment(
        code,
        inlineSourceMap(fixSourceMap(output.map, virtual, output.display))
      )
    }
    io.stdout(code.endsWith('\n') ? code : `${code}\n`)
    if (invocation.declaration && output.declaration !== null) {
      io.stdout(`\n// --- 声明 ${output.declarationName} ---\n`)
      io.stdout(output.declaration.endsWith('\n') ? output.declaration : `${output.declaration}\n`)
    }
    if (multiple && index < outputs.length - 1) {
      io.stdout('\n')
    }
  })
}

const runTsc = async (argv: string[], io: RuntimeIO): Promise<{ code: number }> => {
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  const invocation = parseInvocation(argv)
  if (invocation.mode === 'version') {
    io.stdout(`Version ${detectedVersion}\n`)
    return { code: 0 }
  }
  if (invocation.mode === 'help') {
    io.stdout(USAGE)
    return { code: 0 }
  }
  if (invocation.mode === 'error') {
    io.stderr(invocation.message ?? 'tsc: 参数错误\n')
    return { code: 1 }
  }

  let compiler: TsCompiler
  try {
    compiler = await ensureCompiler(() => undefined)
  } catch (error) {
    io.stderr(
      `tsc: TypeScript 运行时加载失败，需要联网（首次安装约 9MB）：${errorText(error)}\n` +
        '提示：连上网后执行 vm install typescript，装好之后本页内可复用。\n'
    )
    return { code: 1 }
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }

  let outputs: TscOutput[] | null
  try {
    outputs = collectOutput(compiler, invocation, io)
  } catch (error) {
    io.stderr(`tsc: ${errorText(error)}\n`)
    return { code: 1 }
  }
  if (outputs === null) {
    return { code: io.signal?.aborted ? 130 : 1 }
  }
  if (invocation.noEmit) {
    return { code: 0 }
  }
  if (invocation.outfile) {
    const first = outputs[0]
    if (!first) {
      io.stderr('tsc: 没有可写出的结果\n')
      return { code: 1 }
    }
    if (!writeSingleOutput(io, invocation, first)) {
      return { code: io.signal?.aborted ? 130 : 1 }
    }
  } else if (invocation.outdir) {
    if (!writeOutdirOutputs(io, invocation, outputs)) {
      return { code: io.signal?.aborted ? 130 : 1 }
    }
  } else {
    writeStdout(io, invocation, outputs)
  }
  if (io.signal?.aborted) {
    return { code: 130 }
  }
  return { code: 0 }
}

/** TypeScript 5.9（官方 lib/typescript.js UMD）：transpileModule 逐文件转译 */
export const typescriptRuntime: RuntimeModule = {
  load: async (onProgress) => {
    const compiler = await ensureCompiler(onProgress)
    return { version: compiler.version }
  },
  run: async (argv, io) => {
    try {
      return await runTsc(argv, io)
    } catch (error) {
      io.stderr(`tsc: ${errorText(error)}\n`)
      return { code: 1 }
    }
  },
  dispose: () => {
    loadedCompiler = null
    loadingCompiler = null
    detectedVersion = FALLBACK_VERSION
  },
}
