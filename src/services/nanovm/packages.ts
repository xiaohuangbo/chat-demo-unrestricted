import { create } from 'zustand'
import { unzipSync } from 'fflate'
import { dirName, resolvePath, vmFs, type FsEntry, type NanovmFS } from './fs.js'
import { ensureVmCapacity } from './importFile.js'
import { GIT_VERSION, runGit } from './git.js'
import { NODE_VERSION, runNode } from './nodeRuntime.js'
import { nanoVMConfig } from './config.js'
import type {
  ToolchainCategory,
  ToolchainHost,
  ToolchainId,
  ToolchainIO,
  ToolchainState,
} from './types.js'
import type { RuntimeModule } from './runtimes/types.js'
import type { ServeInvocation } from './runtimes/pythonWeb.js'

/**
 * 按需工具链注册表。
 *
 * busybox 自带的那套命令不依赖任何运行时；这里的运行时只在用户或模型真正用到
 * 的时候才加载：
 *
 * - python 从 CDN 下载 Pyodide（约 12MB）；
 * - lua / sqlite / esbuild 分别从 CDN 加载 wasmoon、sql.js、esbuild-wasm；
 * - node / git / make 是纯浏览器实现，安装只是「启用」而已。
 *
 * 新增运行时只需要两步：在 META 里登记，在 RUNTIMES 里挂上动态 import。
 * 安装状态只存 localStorage（`chat-demo:nanovm-packages`），文件仍然都在虚拟文件
 * 系统里；Pyodide 的产物额外放一份到 Cache Storage，下次安装能少下载一点。
 */

const STORAGE_KEY = 'chat-demo:nanovm-packages'
const PYODIDE_VERSION = '0.26.4'

/** Pyodide 官方 CDN：运行时按需从这下载 */
export const PYODIDE_BASE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/'

/** Pyodide 的 ES 模块入口，用动态 import 加载，rspack 不会把它打进 bundle */
export const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs'

/** 工具链展示顺序：控制台与 `vm list` 都按这个顺序排版 */
export const TOOLCHAIN_IDS: ToolchainId[] = [
  'python',
  'node',
  'lua',
  'sqlite',
  'esbuild',
  'typescript',
  'sass',
  'terser',
  'prettier',
  'make',
  'git',
  'pybot',
]

/** 不需要下载、默认启用的运行时（可以 `vm uninstall` 关掉） */
const BUNDLED: ToolchainId[] = ['node', 'git', 'make']

/** 单次同步进 Pyodide / Worker 的内容上限，避免把整块磁盘搬来搬去 */
const SYNC_LIMIT_BYTES = 16 * 1024 * 1024

/** Pyodide 大文件，下载后放进 Cache Storage */
const PYODIDE_WASM_FILE = 'pyodide.asm.wasm'
const PYODIDE_STDLIB_FILE = 'python_stdlib.zip'
const CACHE_NAME = 'nanovm-pyodide-cache'

type Meta = {
  label: string
  summary: string
  sizeMB: number
  version: string
  category: ToolchainCategory
  /** 装好之后给用户的第一条示例命令 */
  hint: string
}

const META: Record<ToolchainId, Meta> = {
  python: {
    label: 'Python 3',
    summary: 'Pyodide 版 CPython，首次使用按需下载',
    sizeMB: 12,
    version: '',
    category: 'runtime',
    hint: 'python3 script.py',
  },
  node: {
    label: 'Node.js',
    summary: '浏览器内置的 JS 运行时，无需下载',
    sizeMB: 0,
    version: `v${NODE_VERSION}`,
    category: 'runtime',
    hint: 'node script.js',
  },
  lua: {
    label: 'Lua 5.4',
    summary: 'wasmoon 版 Lua，脚本与 REPL 都能跑，按需下载',
    sizeMB: 0.4,
    version: '5.4',
    category: 'runtime',
    hint: 'lua script.lua',
  },
  sqlite: {
    label: 'SQLite 3',
    summary: 'sql.js 版 SQLite，直接读写虚拟机里的 .db 文件',
    sizeMB: 1.3,
    version: '3.x',
    category: 'runtime',
    hint: 'sqlite3 app.db "create table t(id integer);"',
  },
  esbuild: {
    label: 'esbuild',
    summary: '浏览器里的 esbuild-wasm，打包 / 转译 TS 与 JS',
    sizeMB: 12,
    version: '0.25',
    category: 'build',
    hint: 'esbuild main.ts --bundle --outfile=bundle.js',
  },
  typescript: {
    label: 'TypeScript',
    summary: '官方 tsc 编译器（浏览器版），转译 .ts / .tsx 到 JS',
    sizeMB: 9,
    version: '5.9',
    category: 'build',
    hint: 'tsc app.ts --outfile app.js',
  },
  sass: {
    label: 'Sass',
    summary: 'dart-sass 官方编译器，SCSS / SASS 转 CSS',
    sizeMB: 5.8,
    version: '1.x',
    category: 'build',
    hint: 'sass style.scss style.css',
  },
  terser: {
    label: 'Terser',
    summary: '官方 JS 压缩器，可做语法压缩与变量重命名',
    sizeMB: 1.1,
    version: '5.x',
    category: 'build',
    hint: 'terser app.js -c -m -o app.min.js',
  },
  prettier: {
    label: 'Prettier',
    summary: '官方代码格式化器，支持 JS / TS / CSS / JSON / Markdown',
    sizeMB: 2,
    version: '3.x',
    category: 'build',
    hint: 'prettier --write src/app.ts',
  },
  make: {
    label: 'GNU make',
    summary: '内置 Makefile 构建器，无需下载',
    sizeMB: 0,
    version: '4.x 兼容',
    category: 'build',
    hint: 'make',
  },
  pybot: {
    label: 'PyBot',
    summary: 'PyBot 超级专家系统：64 万行纯 Python 规则聊天机器人，无模型权重；依赖 Python 工具链',
    sizeMB: 13,
    version: '24cbc04',
    category: 'tool',
    hint: 'pybot -p "你好"',
  },
  git: {
    label: 'Git',
    summary: '内置 git 实现（对象格式与真 git 一致），无需下载',
    sizeMB: 0,
    version: GIT_VERSION,
    category: 'tool',
    hint: 'git status',
  },
}

const TOOLCHAIN_SET = new Set<string>(TOOLCHAIN_IDS)

export const isToolchainId = (value: string): value is ToolchainId => TOOLCHAIN_SET.has(value)

/** 控制台分组顺序 */
export const TOOLCHAIN_CATEGORIES: ToolchainCategory[] = ['runtime', 'build', 'tool']

/** 某分组下的工具链，按 TOOLCHAIN_IDS 的顺序 */
export const toolchainIdsByCategory = (category: ToolchainCategory): ToolchainId[] =>
  TOOLCHAIN_IDS.filter((id) => META[id].category === category)

/** 工具链一句话说明（控制台卡片用） */
export const toolchainSummary = (id: ToolchainId): string => META[id].summary

/** 装好之后给用户的第一条示例命令 */
export const toolchainHint = (id: ToolchainId): string => META[id].hint

// ---------- 运行时模块（动态 import：没装过就不进首屏包） ----------

/**
 * 用 RuntimeModule 接口实现的工具链。python / node / git 有自己的历史实现，
 * 不走这张表；新增运行时在 META 登记之后在这里挂上动态 import 即可。
 */
const RUNTIMES: Partial<Record<ToolchainId, () => Promise<RuntimeModule>>> = {
  lua: () => import('./runtimes/lua.js').then((module) => module.luaRuntime),
  sqlite: () => import('./runtimes/sqlite.js').then((module) => module.sqliteRuntime),
  esbuild: () => import('./runtimes/esbuild.js').then((module) => module.esbuildRuntime),
  typescript: () => import('./runtimes/typescript.js').then((module) => module.typescriptRuntime),
  sass: () => import('./runtimes/sass.js').then((module) => module.sassRuntime),
  terser: () => import('./runtimes/terser.js').then((module) => module.terserRuntime),
  prettier: () => import('./runtimes/prettier.js').then((module) => module.prettierRuntime),
}

const runtimeCache = new Map<ToolchainId, Promise<RuntimeModule>>()

/** 取运行时模块；没有对应模块（内置运行时）返回 null */
const runtimeOf = async (id: ToolchainId): Promise<RuntimeModule | null> => {
  const loader = RUNTIMES[id]
  if (!loader) {
    return null
  }
  const cached = runtimeCache.get(id)
  if (cached) {
    return cached
  }
  const pending = loader()
  runtimeCache.set(id, pending)
  try {
    return await pending
  } catch (error) {
    runtimeCache.delete(id)
    throw error
  }
}

// ---------- 安装状态 ----------

type StoredEntry = {
  /** 已安装时的版本号 */
  version?: string
  installedAt?: number
  /** 用户主动卸载过（内置运行时靠它避免下次启动又被启用） */
  removed?: boolean
}

type StoredPackages = Partial<Record<ToolchainId, StoredEntry>>

export type PackagesStore = {
  states: Record<ToolchainId, ToolchainState>
  /** 正在安装的工具链 */
  busy: ToolchainId | null
  /** 是否已从存储里恢复安装状态（同步恢复，恒为 true） */
  ready: boolean
}

const emptyState = (id: ToolchainId): ToolchainState => ({
  id,
  label: META[id].label,
  summary: META[id].summary,
  installed: false,
  sizeMB: META[id].sizeMB,
  category: META[id].category,
})

const readStored = (): StoredPackages => {
  try {
    if (typeof localStorage === 'undefined') {
      return {}
    }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const source = parsed as Record<string, unknown>
    const out: StoredPackages = {}
    for (const id of TOOLCHAIN_IDS) {
      const entry = source[id]
      if (typeof entry !== 'object' || entry === null) {
        continue
      }
      const record = entry as StoredEntry
      out[id] = {
        version: typeof record.version === 'string' ? record.version : undefined,
        installedAt: typeof record.installedAt === 'number' ? record.installedAt : undefined,
        removed: record.removed === true,
      }
    }
    return out
  } catch {
    return {}
  }
}

const writeStored = (states: Record<ToolchainId, ToolchainState>) => {
  const out: StoredPackages = {}
  for (const id of TOOLCHAIN_IDS) {
    const state = states[id]
    if (state.installed) {
      out[id] = { version: state.version, installedAt: Date.now() }
    } else if (BUNDLED.includes(id)) {
      // 内置运行时被卸载过：记下来，下次启动不要自动启用
      out[id] = { removed: true }
    }
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
    }
  } catch {
    // 隐私模式写不进去也不影响本次会话
  }
}

/** 由存储 + 内置默认值算出初始状态 */
const initialState = (id: ToolchainId, stored: StoredPackages): ToolchainState => {
  const state = emptyState(id)
  const entry = stored[id]
  if (entry?.version && entry.removed !== true) {
    return { ...state, installed: true, version: entry.version }
  }
  if (BUNDLED.includes(id) && entry?.removed !== true) {
    return { ...state, installed: true, version: META[id].version }
  }
  return state
}

const initialStates = (): Record<ToolchainId, ToolchainState> => {
  const stored = readStored()
  const out = {} as Record<ToolchainId, ToolchainState>
  for (const id of TOOLCHAIN_IDS) {
    out[id] = initialState(id, stored)
  }
  return out
}

export const usePackages = create<PackagesStore>(() => ({
  states: initialStates(),
  busy: null,
  ready: true,
}))

const patchState = (id: ToolchainId, patch: Partial<ToolchainState>) => {
  usePackages.setState((state) => ({
    states: { ...state.states, [id]: { ...state.states[id], ...patch } },
  }))
}

/** 恢复安装状态：初始化时已经同步读过存储，这里主要是给 UI 一个 await 的入口 */
export const hydratePackages = async (): Promise<void> => {
  const stored = readStored()
  const states = usePackages.getState().states
  for (const id of TOOLCHAIN_IDS) {
    if (states[id].installed) {
      continue
    }
    const next = initialState(id, stored)
    if (next.installed) {
      patchState(id, { installed: true, version: next.version })
    }
  }
  usePackages.setState({ ready: true })
}

const stateOf = (id: ToolchainId): ToolchainState => usePackages.getState().states[id]

export const toolchainSizeMB = (id: ToolchainId): number => META[id].sizeMB

// ---------- Python（Pyodide） ----------

/** Pyodide 的 FS 子集，够我们同步文件就行 */
type PyodideFs = {
  mkdirTree?: (path: string) => void
  writeFile: (path: string, data: Uint8Array) => void
  readFile: (path: string) => Uint8Array
  readdir: (path: string) => string[]
  stat: (path: string) => { mode: number }
  isDir?: (mode: number) => boolean
}

type PyodideLike = {
  version?: string
  FS: PyodideFs
  globals: { get: (name: string) => unknown }
  runPython: (code: string) => unknown
  /** micropip 的安装是 async 的，必须走 runPythonAsync（允许顶层 await） */
  runPythonAsync: (code: string) => Promise<unknown>
  /** 加载 Pyodide 发行版自带的包（pip 依赖这里的 micropip） */
  loadPackage: (names: string | string[]) => Promise<unknown>
  setStdout: (options: { batched?: (text: string) => void }) => void
  setStderr: (options: { batched?: (text: string) => void }) => void
  /** stdin 回调可以返回字符串、UTF-8 字节或 null（EOF） */
  setStdin?: (options: { stdin: () => string | Uint8Array | null }) => void
}

type PyodideModule = {
  loadPyodide: (options: { indexURL: string }) => Promise<PyodideLike>
}

type PythonRuntime = {
  pyodide: PyodideLike
  version: string
}

let pythonRuntime: PythonRuntime | null = null
let pythonLoading: Promise<PythonRuntime> | null = null

/** 已经注入过 nanovm 模块的 Pyodide 实例（每个实例只注入一次） */
let pythonWebInstance: PyodideLike | null = null

/** 上一次同步进 os.environ 的变量名：下次同步时删掉已经消失的变量 */
let syncedPythonEnv = new Set<string>()

/** pythonWeb.ts 里带着三段 Python 源码，按需加载（和 runtimes 的动态 import 保持一致） */
type PythonWebModule = typeof import('./runtimes/pythonWeb.js')
let pythonWebLoading: Promise<PythonWebModule> | null = null

const loadPythonWeb = (): Promise<PythonWebModule> => {
  pythonWebLoading ??= import('./runtimes/pythonWeb.js')
  return pythonWebLoading
}

let pyodideBase = PYODIDE_BASE_URL
let pyodideModuleUrl = PYODIDE_URL

/**
 * 允许把 Pyodide 换到自建镜像 / 本地目录（离线部署、内网环境用）。
 * 传 null 恢复官方 CDN。
 */
export const setPyodideMirror = (base: string | null) => {
  pyodideBase = base ? (base.endsWith('/') ? base : `${base}/`) : PYODIDE_BASE_URL
  pyodideModuleUrl = `${pyodideBase}pyodide.mjs`
  pythonRuntime = null
  pythonLoading = null
}

/** 当前使用的 Pyodide indexURL */
export const pyodideIndexURL = (): string => pyodideBase

/**
 * 远程 ESM 只能靠原生 import 加载：`new Function` 里的 import 不会被 rspack 打包，
 * 所以 Pyodide 主模块永远不进入 bundle。
 */
const importRemote = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const cacheStorage = (): CacheStorage | null => {
  try {
    return typeof caches === 'undefined' ? null : caches
  } catch {
    return null
  }
}

const readCachedBytes = async (url: string): Promise<Uint8Array | null> => {
  const storage = cacheStorage()
  if (!storage) {
    return null
  }
  try {
    const cache = await storage.open(CACHE_NAME)
    const response = await cache.match(url)
    return response ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

const writeCachedBytes = async (url: string, bytes: Uint8Array): Promise<void> => {
  const storage = cacheStorage()
  if (!storage) {
    return
  }
  try {
    const cache = await storage.open(CACHE_NAME)
    await cache.put(url, new Response(toArrayBuffer(bytes)))
  } catch {
    // 缓存失败不影响安装
  }
}

/** 带进度的下载：拿不到 content-length 时只报「还在下载」 */
const downloadWithProgress = async (
  url: string,
  onProgress: (fraction: number) => void
): Promise<Uint8Array | null> => {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }
    const total = Number(response.headers.get('content-length') ?? 0)
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      onProgress(1)
      return bytes
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      chunks.push(chunk.value)
      received += chunk.value.byteLength
      if (total > 0) {
        onProgress(Math.min(0.99, received / total))
      }
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    onProgress(1)
    return bytes
  } catch {
    return null
  }
}

/**
 * 安装 Pyodide 期间把已经下好的大文件就地喂给 loadPyodide，
 * 避免「预下载一遍 + 再下载一遍」。只拦截我们自己缓存的 URL，其余请求原样放行。
 */
const serveCachedFetch = (entries: Map<string, Uint8Array>): (() => void) => {
  const original = globalThis.fetch
  if (entries.size === 0) {
    return () => undefined
  }
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const bytes = entries.get(url)
    if (!bytes) {
      return original(input, init)
    }
    return new Response(toArrayBuffer(bytes), {
      status: 200,
      headers: {
        'content-type': url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
      },
    })
  }
  globalThis.fetch = patched as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const detectPythonVersion = (pyodide: PyodideLike): string => {
  try {
    const version = pyodide.runPython('import sys\nsys.version.split()[0]')
    return typeof version === 'string' && version ? version : META.python.label
  } catch {
    return META.python.label
  }
}

const loadPythonRuntime = async (
  onProgress: (fraction: number) => void
): Promise<PythonRuntime> => {
  if (pythonRuntime) {
    onProgress(1)
    return pythonRuntime
  }
  if (pythonLoading) {
    return pythonLoading
  }
  const pending = (async (): Promise<PythonRuntime> => {
    const wasmUrl = `${pyodideBase}${PYODIDE_WASM_FILE}`
    const stdlibUrl = `${pyodideBase}${PYODIDE_STDLIB_FILE}`
    const cached = new Map<string, Uint8Array>()

    onProgress(0.02)
    let wasm = await readCachedBytes(wasmUrl)
    if (wasm) {
      cached.set(wasmUrl, wasm)
      onProgress(0.55)
    } else {
      wasm = await downloadWithProgress(wasmUrl, (fraction) => onProgress(0.03 + fraction * 0.55))
      if (wasm) {
        cached.set(wasmUrl, wasm)
        await writeCachedBytes(wasmUrl, wasm)
      }
    }

    let stdlib = await readCachedBytes(stdlibUrl)
    if (stdlib) {
      cached.set(stdlibUrl, stdlib)
      onProgress(0.72)
    } else {
      stdlib = await downloadWithProgress(stdlibUrl, (fraction) =>
        onProgress(0.6 + fraction * 0.15)
      )
      if (stdlib) {
        cached.set(stdlibUrl, stdlib)
        await writeCachedBytes(stdlibUrl, stdlib)
      }
    }
    onProgress(0.8)

    const restoreFetch = serveCachedFetch(cached)
    try {
      const module = (await importRemote(pyodideModuleUrl)) as PyodideModule
      onProgress(0.86)
      const pyodide = await module.loadPyodide({ indexURL: pyodideBase })
      onProgress(0.96)
      const version = detectPythonVersion(pyodide)
      const runtime: PythonRuntime = { pyodide, version }
      pythonRuntime = runtime
      onProgress(1)
      return runtime
    } finally {
      restoreFetch()
    }
  })()
  pythonLoading = pending
  try {
    return await pending
  } finally {
    pythonLoading = null
  }
}

/** 加载 Python 运行时；失败时给出中文提示并返回 null */
const ensurePythonRuntime = async (io: ToolchainIO): Promise<PythonRuntime | null> => {
  try {
    return await loadPythonRuntime(() => undefined)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    io.stderr(
      `python3: Python 运行时加载失败，需要联网（首次安装约 12MB）：${detail}\n` +
        '提示：连上网后执行 vm install python，装好之后本页内可离线复用。\n'
    )
    return null
  }
}

/**
 * stdin 的一次性喂料：CGI 的请求体一次给完，之后返回 null（EOF）。
 * 返回 Uint8Array 而不是字符串，Pyodide 就不会自作主张补换行。
 */
const stdinFeeder = (text: string): (() => string | Uint8Array | null) => {
  let pending = text
  return () => {
    if (!pending) {
      return null
    }
    const bytes = new TextEncoder().encode(pending)
    pending = ''
    return bytes
  }
}

/**
 * 把 io 的 stdout / stderr / stdin 接到 Pyodide 上（每次运行都要重接）。
 *
 * 传了 `collect` 就不直接往 io 写，而是把每一行收进数组：CGI 响应必须原样交给
 * 虚拟网络，Pyodide 的 batched stdout 会把「没有换行结尾的最后一行」憋在缓冲区
 * 里（直到下一条输出才吐出来），所以 run_cgi 写响应时会补一个哨兵换行，
 * 由调用方用 join('\n') 重拼，正文不会多出字节。
 */
const attachPythonIO = (
  io: ToolchainIO,
  pyodide: PyodideLike,
  stdin: string,
  collect?: string[]
): void => {
  try {
    pyodide.setStdout({
      batched: (text) => {
        if (collect) {
          collect.push(text)
          return
        }
        io.stdout(`${text}\n`)
      },
    })
    pyodide.setStderr({ batched: (text) => io.stderr(`${text}\n`) })
    pyodide.setStdin?.({ stdin: stdinFeeder(stdin) })
  } catch {
    // setStdout / setStderr 不可用时只能拿到 runPython 的返回值
  }
}

/**
 * 把 io.env 同步进 os.environ：虚拟网络的 NANOVM_HTTP_* 由宿主放在这里，
 * nanovm_serve 读取它们来构造 WSGI environ。每次运行都同步，删掉已经消失的变量。
 */
const syncPythonEnv = (pyodide: PyodideLike, env: Record<string, string>): void => {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key) {
      values[key] = value
    }
  }
  const removed = [...syncedPythonEnv].filter((key) => !(key in values))
  try {
    pyodide.runPython(
      [
        'import os',
        `_nanovm_env = ${JSON.stringify(values)}`,
        `for _nanovm_key in ${JSON.stringify(removed)}:`,
        '    os.environ.pop(_nanovm_key, None)',
        'os.environ.update(_nanovm_env)',
      ].join('\n')
    )
    syncedPythonEnv = new Set(Object.keys(values))
  } catch {
    // 同步失败不影响命令本身
  }
}

/**
 * 每个 Pyodide 实例第一次用到时注入 nanovm 模块（写 FS + sys.path.insert）；
 * 之后只同步环境变量。注入失败不影响普通脚本，只是 import nanovm 用不了。
 */
const ensurePythonWeb = (pyodide: PyodideLike, io: ToolchainIO, web: PythonWebModule): void => {
  try {
    if (pythonWebInstance !== pyodide) {
      pyodide.runPython(web.NANOVM_BOOTSTRAP)
      pythonWebInstance = pyodide
      syncedPythonEnv = new Set()
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    io.stderr(`python3: nanovm 模块注入失败，import nanovm / -m nanovm_serve 不可用：${detail}\n`)
  }
  syncPythonEnv(pyodide, io.env)
}

/** 读 buildPythonRunner / buildServeRunner 写下的退出码 */
const readPythonExitCode = (pyodide: PyodideLike): number => {
  const value = pyodide.globals.get('__nanovm_exit_code')
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const pythonVersionLabel = (): string => {
  const version = stateOf('python').version
  return version || `3.x（Pyodide ${PYODIDE_VERSION}）`
}

/** 需要同步进 Pyodide 的 VFS 目录 */
const pythonRoots = (io: ToolchainIO, script: string | null): string[] => {
  const roots = new Set<string>(['/home/user', '/tmp'])
  if (io.cwd && io.cwd !== '/') {
    roots.add(io.cwd)
  }
  if (script) {
    roots.add(dirName(script))
  }
  return [...roots]
}

const collectFiles = (
  fs: NanovmFS,
  roots: string[],
  limit: number
): { files: Map<string, Uint8Array>; skipped: number } => {
  const files = new Map<string, Uint8Array>()
  let skipped = 0
  let total = 0
  for (const root of roots) {
    const stat = fs.stat(root)
    if (!stat) {
      continue
    }
    const entries: FsEntry[] = stat.kind === 'dir' ? fs.walk(root) : [stat]
    for (const entry of entries) {
      if (entry.kind !== 'file' || files.has(entry.path)) {
        continue
      }
      if (total + entry.size > limit) {
        skipped += 1
        continue
      }
      let bytes: Uint8Array | null = null
      try {
        bytes = fs.read(entry.path)
      } catch {
        bytes = null
      }
      if (!bytes) {
        continue
      }
      files.set(entry.path, bytes)
      total += bytes.byteLength
    }
  }
  return { files, skipped }
}

const isPythonDir = (fs: PyodideFs, path: string): boolean => {
  try {
    const stat = fs.stat(path)
    if (typeof fs.isDir === 'function') {
      return fs.isDir(stat.mode)
    }
    return (stat.mode & 0o170000) === 0o040000
  } catch {
    return false
  }
}

/** 列出 Pyodide FS 里某个目录下的所有文件 */
const readPyodideTree = (fs: PyodideFs, roots: string[]): Map<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>()
  const visit = (path: string) => {
    let names: string[] = []
    try {
      names = fs.readdir(path)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') {
        continue
      }
      const child = path === '/' ? `/${name}` : `${path}/${name}`
      if (isPythonDir(fs, child)) {
        visit(child)
        continue
      }
      try {
        files.set(child, new Uint8Array(fs.readFile(child)))
      } catch {
        // 单个文件读不出来就跳过
      }
    }
  }
  for (const root of roots) {
    if (isPythonDir(fs, root)) {
      visit(root)
    }
  }
  return files
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

const syncIntoPyodide = (fs: PyodideFs, files: Map<string, Uint8Array>) => {
  for (const [path, bytes] of files) {
    const parent = dirName(path)
    try {
      fs.mkdirTree?.(parent)
    } catch {
      // 目录已存在
    }
    try {
      fs.writeFile(path, bytes)
    } catch {
      // 写不进去（只读目录等）时跳过
    }
  }
}

/** 把 Pyodide FS 里改动过的文件写回 VFS */
const syncBackFromPyodide = (
  fs: NanovmFS,
  before: Map<string, Uint8Array>,
  roots: string[],
  pyodideFs: PyodideFs
) => {
  const after = readPyodideTree(pyodideFs, roots)
  for (const [path, bytes] of after) {
    const previous = before.get(path)
    if (previous && equalBytes(previous, bytes)) {
      continue
    }
    try {
      fs.mkdir(dirName(path), true)
      fs.write(path, bytes)
    } catch {
      // 容量不足 / 路径冲突时跳过，不打断 Python 的返回值
    }
  }
  for (const path of before.keys()) {
    if (after.has(path)) {
      continue
    }
    try {
      fs.remove(path)
    } catch {
      // 已经被别处删掉了
    }
  }
}

// ---------- pip（Pyodide 自带的 micropip） ----------

/**
 * NanoVM 的 pip 由 Pyodide 发行版自带的 micropip 实现：它只解析纯 Python wheel
 * 和 Pyodide 预编译好的 wasm 包，需要现场编译 C 扩展的会在依赖解析阶段报错。
 */
const PIP_USAGE = [
  '用法：pip <子命令> [参数...]',
  '',
  '  pip install <包> [包...]    安装纯 Python 包（-r 可读 requirements.txt）',
  '  pip uninstall <包> [包...]  卸载 micropip 装过的包',
  '  pip list                    已安装的包（Pyodide 内置 + micropip 装的）',
  '  pip --version               版本信息',
  '',
  '只装纯 Python wheel 与 Pyodide 预编译的 wasm 包（numpy / pandas 等）；',
  '需要现场编译 C 扩展的包（cryptography、uvloop、pydantic-core…）装不了。',
  '',
].join('\n')

/** Pyodide 0.26.4 的 pyodide-lock.json 里锁定的 micropip 版本 */
const MICROPIP_VERSION = '0.6.0'

/** `pip install` 解析出来的东西 */
type PipInstallOptions = {
  requirements: string[]
  indexUrls: string[]
  deps: boolean
  pre: boolean
  verbose: boolean
}

/** 带独立取值的 pip 选项：值不是包名，不能放进 requirements */
const PIP_VALUE_OPTIONS = new Set([
  '-i',
  '--index-url',
  '--extra-index-url',
  '--trusted-host',
  '--target',
  '--prefix',
  '--root',
  '--platform',
  '--python-version',
  '--implementation',
  '--abi',
  '--only-binary',
  '--no-binary',
  '--progress-bar',
  '--log',
  '--timeout',
  '--retries',
  '--proxy',
  '--cert',
  '--client-cert',
  '--cache-dir',
  '--src',
  '--upgrade-strategy',
  '-c',
  '--constraint',
])

/** 解析 `pip install` 的参数（-r 会直接读虚拟文件系统里的依赖清单） */
const parsePipInstall = (io: ToolchainIO, argv: string[]): PipInstallOptions => {
  const options: PipInstallOptions = {
    requirements: [],
    indexUrls: [],
    deps: true,
    pre: false,
    verbose: true,
  }
  const args = [...argv]
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-r' || arg === '--requirement') {
      const file = args[index + 1] ?? ''
      index += 1
      const path = file ? resolvePath(io.cwd, file) : ''
      const source = path ? io.fs.readText(path) : null
      if (source === null) {
        io.stderr(`pip: 读不到依赖清单 '${file}'\n`)
        continue
      }
      for (const line of source.split('\n')) {
        const trimmed = line.split('#')[0].trim()
        if (trimmed && !trimmed.startsWith('-')) {
          options.requirements.push(trimmed)
        }
      }
      continue
    }
    if (arg === '-i' || arg === '--index-url' || arg === '--extra-index-url') {
      const url = args[index + 1]
      index += 1
      if (url) {
        options.indexUrls.push(url)
      }
      continue
    }
    if (PIP_VALUE_OPTIONS.has(arg)) {
      index += 1
      continue
    }
    if (arg === '--no-deps') {
      options.deps = false
      continue
    }
    if (arg === '--pre') {
      options.pre = true
      continue
    }
    if (arg === '-q' || arg === '--quiet') {
      options.verbose = false
      continue
    }
    if (arg === '-v' || arg === '--verbose') {
      options.verbose = true
      continue
    }
    if (
      arg === '-U' ||
      arg === '--upgrade' ||
      arg === '--user' ||
      arg === '--force-reinstall' ||
      arg === '--no-cache-dir' ||
      arg === '--no-warn-script-location'
    ) {
      continue
    }
    if (arg.startsWith('-')) {
      io.stderr(`pip: 忽略不支持的选项 '${arg}'\n`)
      continue
    }
    options.requirements.push(arg)
  }
  return options
}

/** 网络 / 下载类的失败：可以自动重试一次 */
const PIP_NETWORK_ERROR = /failed to fetch|networkerror|network error|load failed|timed out/i

/** micropip 的报错翻译成中文：最典型的是「没有纯 Python wheel」 */
const pipFailureMessage = (detail: string): string => {
  const text = detail.replace(/\s+/g, ' ').trim()
  if (
    /pure python 3 wheel|pure-python|not a supported wheel|platform tag|abi3|manylinux/i.test(text)
  ) {
    return (
      `pip: 该包需要编译好的 wasm 扩展，Pyodide 里装不了：${text}\n` +
      '提示：包名写错时 micropip 也报同样的错，先用 PyPI 页面确认一下包名。'
    )
  }
  if (/no matching distribution|could not find a version|not found|404/i.test(text)) {
    return `pip: PyPI 上找不到这个包（检查包名或版本）：${text}`
  }
  if (PIP_NETWORK_ERROR.test(text)) {
    return `pip: 下载失败，检查网络能不能访问 PyPI / jsDelivr：${text}`
  }
  return `pip: 该包需要编译好的 wasm 扩展，Pyodide 里装不了：${text}`
}

/** 已安装包的列表：优先 micropip.list()，老版本 micropip 退到 importlib.metadata */
const PIP_LIST_SOURCE = [
  'import importlib.metadata',
  '',
  'try:',
  '    import micropip',
  'except ImportError:',
  '    micropip = None',
  '',
  '_nanovm_list = getattr(micropip, "list", None)',
  'if _nanovm_list is not None:',
  '    print(_nanovm_list())',
  'else:',
  '    print("Package                        Version")',
  '    print("------------------------------ ---------")',
  '    for _nanovm_dist in sorted(',
  '        importlib.metadata.distributions(), key=lambda item: (item.name or "").lower()',
  '    ):',
  '        print("%-30s %s" % (_nanovm_dist.name, _nanovm_dist.version))',
].join('\n')

/** micropip 的版本号：实例里已经 import 过就读真值，否则用锁定的版本 */
const micropipVersionLabel = (): string => {
  const runtime = pythonRuntime
  if (runtime) {
    try {
      const value = runtime.pyodide.runPython('import micropip\nmicropip.__version__')
      if (typeof value === 'string' && value) {
        return `micropip ${value}`
      }
    } catch {
      // 还没 loadPackage('micropip')，用锁文件里的版本号
    }
  }
  return `micropip ${MICROPIP_VERSION}`
}

/**
 * 准备 pip 的执行环境：运行时 + ios + nanovm 模块。
 * pip 的输出走 io.stdout（micropip 的日志 handler 绑在 sys.stdout 上）。
 */
const preparePip = async (io: ToolchainIO): Promise<{ pyodide: PyodideLike } | null> => {
  const runtime = await ensurePythonRuntime(io)
  if (!runtime) {
    return null
  }
  attachPythonIO(io, runtime.pyodide, '')
  const web = await loadPythonWeb()
  ensurePythonWeb(runtime.pyodide, io, web)
  // micropip 的 logging handler 只在第一次 import 时绑一次 sys.stdout；
  // 每次运行 Pyodide 都会换掉 sys.stdout，这里把它重新指到当前输出上。
  try {
    runtime.pyodide.runPython(
      [
        'import logging, sys',
        'for _nanovm_name in (None, "micropip"):',
        '    for _nanovm_handler in logging.getLogger(_nanovm_name).handlers:',
        '        if isinstance(_nanovm_handler, logging.StreamHandler):',
        '            _nanovm_handler.setStream(sys.stdout)',
      ].join('\n')
    )
  } catch {
    // 重绑失败只影响日志去向
  }
  return { pyodide: runtime.pyodide }
}

const runPipInstall = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  const options = parsePipInstall(io, argv)
  if (options.requirements.length === 0) {
    io.stderr('pip: 没有要安装的包，用法：pip install <包> [包...]\n')
    return { code: 1 }
  }
  const runtime = await preparePip(io)
  if (!runtime) {
    return { code: 1 }
  }
  // 异常在 Python 里就转成字符串返回：micropip 的报错本来就带 FAQ 链接，
  // 别再让 Pyodide 往 stderr 甩一整段 traceback
  const source = [
    'import micropip',
    'import traceback',
    '_nanovm_error = None',
    'try:',
    '    await micropip.install(',
    `        ${JSON.stringify(options.requirements)},`,
    `        deps=${options.deps ? 'True' : 'False'},`,
    `        pre=${options.pre ? 'True' : 'False'},`,
    '        keep_going=True,',
    `        index_urls=${
      options.indexUrls.length > 0 ? JSON.stringify(options.indexUrls) : 'None'
    },`,
    `        verbose=${options.verbose ? 'True' : 'False'},`,
    '    )',
    'except BaseException as _nanovm_exc:',
    '    _nanovm_error = "".join(',
    '        traceback.format_exception_only(type(_nanovm_exc), _nanovm_exc)',
    '    ).strip()',
    '_nanovm_error',
  ].join('\n')
  let failure = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await runtime.pyodide.loadPackage('micropip')
      const result = await runtime.pyodide.runPythonAsync(source)
      failure = typeof result === 'string' ? result : ''
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (!failure || !PIP_NETWORK_ERROR.test(failure) || attempt === 1) {
      break
    }
    // 虚拟网络 / CDN 偶尔断一下，重试一次比直接失败友好
    io.stderr('pip: 下载中断，正在重试一次…\n')
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500)
    })
  }
  if (failure) {
    io.stderr(`${pipFailureMessage(failure)}\n`)
    return { code: 1 }
  }
  io.stdout(`pip: 已装好 ${options.requirements.join(' ')}，可以直接 import\n`)
  return { code: 0 }
}

const runPipUninstall = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  const packages = argv.filter((arg) => !arg.startsWith('-'))
  if (packages.length === 0) {
    io.stderr('pip: 没有要卸载的包，用法：pip uninstall <包> [包...]\n')
    return { code: 1 }
  }
  const runtime = await preparePip(io)
  if (!runtime) {
    return { code: 1 }
  }
  try {
    await runtime.pyodide.loadPackage('micropip')
    const available = runtime.pyodide.runPython('import micropip\nhasattr(micropip, "uninstall")')
    if (available !== true) {
      io.stderr(
        'pip: 当前 Pyodide 的 micropip 不支持 uninstall（需要 micropip ≥ 0.4），' +
          '可以 vm uninstall python 之后重装运行时\n'
      )
      return { code: 1 }
    }
    // micropip.uninstall 对不存在的包只 warning 不报错，这里先自己判断一遍
    const failure = runtime.pyodide.runPython(
      [
        'import importlib.metadata',
        'import micropip',
        'import traceback',
        `_nanovm_names = ${JSON.stringify(packages)}`,
        '_nanovm_missing = []',
        'for _nanovm_name in _nanovm_names:',
        '    try:',
        '        importlib.metadata.distribution(_nanovm_name)',
        '    except importlib.metadata.PackageNotFoundError:',
        '        _nanovm_missing.append(_nanovm_name)',
        '_nanovm_error = None',
        'if _nanovm_missing:',
        "    _nanovm_error = '没有安装：' + ', '.join(_nanovm_missing)",
        'else:',
        '    try:',
        '        micropip.uninstall(_nanovm_names)',
        '    except BaseException as _nanovm_exc:',
        '        _nanovm_error = "".join(',
        '            traceback.format_exception_only(type(_nanovm_exc), _nanovm_exc)',
        '        ).strip()',
        '_nanovm_error',
      ].join('\n')
    )
    if (typeof failure === 'string' && failure) {
      io.stderr(`pip: ${failure}\n`)
      return { code: 1 }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    io.stderr(`pip: 卸载失败：${detail}\n`)
    return { code: 1 }
  }
  io.stdout(`pip: 已卸载 ${packages.join(' ')}\n`)
  return { code: 0 }
}

const runPipList = async (io: ToolchainIO): Promise<{ code: number }> => {
  const runtime = await preparePip(io)
  if (!runtime) {
    return { code: 1 }
  }
  try {
    await runtime.pyodide.loadPackage('micropip')
  } catch {
    // 装不上 micropip 也还能用 importlib.metadata 列表
  }
  try {
    runtime.pyodide.runPython(PIP_LIST_SOURCE)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    io.stderr(`pip: 列出已安装的包失败：${detail}\n`)
    return { code: 1 }
  }
  return { code: 0 }
}

/** pip 的命令分发：argv 是 `pip` 之后的部分 */
const runPip = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  const command = argv[0] ?? ''
  if (!command) {
    io.stderr(PIP_USAGE)
    return { code: 1 }
  }
  if (command === '-h' || command === '--help' || command === 'help') {
    io.stdout(PIP_USAGE)
    return { code: 0 }
  }
  if (command === '--version' || command === '-V') {
    io.stdout(`pip（${micropipVersionLabel()}，Pyodide ${PYODIDE_VERSION}）\n`)
    return { code: 0 }
  }
  if (command === 'install') {
    return runPipInstall(io, argv.slice(1))
  }
  if (command === 'uninstall') {
    return runPipUninstall(io, argv.slice(1))
  }
  if (command === 'list') {
    return runPipList(io)
  }
  if (command === 'freeze') {
    io.stderr(
      'pip: 不支持 freeze（micropip.freeze() 输出的是 Pyodide 锁文件，不是 requirements 格式），' +
        '请用 pip list 看已安装的包\n'
    )
    return { code: 1 }
  }
  io.stderr(`pip: 不支持的子命令 '${command}'\n${PIP_USAGE}`)
  return { code: 1 }
}

type PythonMode = 'script' | 'code' | 'stdin' | 'version' | 'help' | 'module'

type PythonInvocation = {
  mode: PythonMode
  script?: string
  code?: string
  args: string[]
  unknown?: string
}

const parsePythonArgs = (argv: string[]): PythonInvocation => {
  const args = [...argv]
  const rest: string[] = []
  while (args.length > 0) {
    const arg = args[0]
    if (arg === '-c') {
      return { mode: 'code', code: args[1] ?? '', args: args.slice(2) }
    }
    if (arg === '-V' || arg === '--version') {
      return { mode: 'version', args: [] }
    }
    if (arg === '-h' || arg === '--help') {
      return { mode: 'help', args: [] }
    }
    if (arg === '-m') {
      return { mode: 'module', args: args.slice(1) }
    }
    if (['-u', '-B', '-O', '-OO', '-s', '-E', '-q', '-i', '-b', '-d'].includes(arg)) {
      args.shift()
      continue
    }
    if (arg === '-') {
      return { mode: 'stdin', args: args.slice(1) }
    }
    if (arg === '--') {
      args.shift()
      const script = args.shift()
      return script ? { mode: 'script', script, args } : { mode: 'stdin', args: [] }
    }
    if (arg.startsWith('-')) {
      return { mode: 'help', args: [], unknown: arg }
    }
    return { mode: 'script', script: arg, args: args.slice(1) }
  }
  return { mode: 'stdin', args: rest }
}

const PYTHON_USAGE = [
  '用法：python3 [-c "代码"] [脚本.py] [参数...]',
  '      python3 -m pip install <包>      用 micropip 装纯 Python 包',
  '      python3 -m nanovm_serve app:app  虚拟网络里的 WSGI 入口（vm serve 用）',
  '',
  'Pyodide 版 CPython（WASM），标准库齐全；pip 只装纯 Python wheel 与 Pyodide',
  '预编译好的 wasm 包（numpy / pandas 等），需要编译 C 扩展的包装不了。',
  '脚本所在的目录、/home/user 与 /tmp 会同步进 Python 的文件系统，',
  '脚本写出的文件会自动回到虚拟文件系统里。',
  '',
].join('\n')

const buildPythonRunner = (
  mode: 'script' | 'code' | 'stdin',
  options: { script: string | null; code: string; argv: string[] }
): string => {
  const lines: string[] = ['import sys', `sys.argv = ${JSON.stringify(options.argv)}`]
  if (options.script) {
    lines.push(`sys.path.insert(0, ${JSON.stringify(dirName(options.script))})`)
  }
  const fileLiteral = options.script ? JSON.stringify(options.script) : "'<string>'"
  lines.push(
    '__nanovm_exit_code = 0',
    `__nanovm_globals = {'__name__': '__main__', '__file__': ${fileLiteral}, ` +
      "'__builtins__': __builtins__, '__package__': None, '__spec__': None, " +
      "'__loader__': None, '__cached__': None, '__doc__': None}",
    'try:'
  )
  if (mode === 'script' && options.script) {
    const script = JSON.stringify(options.script)
    lines.push(
      `    with open(${script}, 'r', encoding='utf-8', errors='replace') as __nanovm_handle:`,
      '        __nanovm_source = __nanovm_handle.read()',
      `    exec(compile(__nanovm_source, ${script}, 'exec'), __nanovm_globals)`
    )
  } else {
    const source = mode === 'stdin' ? 'sys.stdin.read()' : JSON.stringify(options.code)
    const filename = mode === 'stdin' ? "'<stdin>'" : "'<string>'"
    lines.push(`    exec(compile(${source}, ${filename}, 'exec'), __nanovm_globals)`)
  }
  lines.push(
    'except SystemExit as __nanovm_signal:',
    '    __nanovm_status = __nanovm_signal.code',
    '    if __nanovm_status is None:',
    '        __nanovm_exit_code = 0',
    '    elif isinstance(__nanovm_status, int):',
    '        __nanovm_exit_code = __nanovm_status',
    '    else:',
    "        sys.stderr.write(str(__nanovm_status) + '\\n')",
    '        __nanovm_exit_code = 1',
    'except KeyboardInterrupt:',
    "    sys.stderr.write('KeyboardInterrupt\\n')",
    '    __nanovm_exit_code = 130',
    'except BaseException:',
    '    import traceback',
    '    traceback.print_exc()',
    '    __nanovm_exit_code = 1'
  )
  return `${lines.join('\n')}\n`
}

/** PyBot 的源码目录：从内置 zip 解压到这里，和用户文件分开 */
export const PYBOT_ROOT = '/opt/pybot'
/** PyBot 单次同步上限：源码约 39MB，默认 16MB 会漏文件 */
const PYBOT_SYNC_LIMIT = 64 * 1024 * 1024

const installPybot = async (report: (progress: number) => void): Promise<void> => {
  const url = new URL('pybot.zip', document.baseURI).href
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch (error) {
    throw new Error(`无法读取内置的 PyBot 包：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`无法读取内置的 PyBot 包（HTTP ${response.status}）`)
  }
  report(0.2)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const entries = Object.entries(unzipSync(bytes)).filter(
    ([name, data]) => !name.endsWith('/') && data.byteLength >= 0
  )
  if (entries.length === 0) {
    throw new Error('PyBot 包为空或格式不正确')
  }
  const total = entries.reduce((sum, [, data]) => sum + data.byteLength, 0)
  ensureVmCapacity(total)
  vmFs.mkdir(PYBOT_ROOT, true)
  let done = 0
  for (const [name, data] of entries) {
    const clean = name.replace(/^\.\//, '')
    if (!clean || clean.includes('..')) {
      continue
    }
    const target = `${PYBOT_ROOT}/${clean}`
    vmFs.mkdir(dirName(target), true)
    vmFs.write(target, data)
    done += 1
    if (done % 20 === 0 || done === entries.length) {
      report(0.2 + (done / entries.length) * 0.75)
    }
  }
  await vmFs.persist()
  report(1)
}

// ---------- PyBot 交互式会话 ----------

type PybotSession = {
  pyodide: PyodideLike
  /** 已同步过的根目录，避免每轮重复写 39MB */
  ready: boolean
}

let pybotSession: PybotSession | null = null

const PYBOT_BOOTSTRAP = `import json, sys, time
sys.path.insert(0, '/opt/pybot')
from bot import runtime as __nanovm_bot_runtime
__nanovm_bot_memory = {}

def __nanovm_pybot_reset():
    global __nanovm_bot_memory
    __nanovm_bot_memory = {}

def __nanovm_pybot_turn(__text):
    start = time.perf_counter()
    try:
        result = __nanovm_bot_runtime.turn(__text, __nanovm_bot_memory)
        reply = ' '.join(str(result['reply']).split()) or 'Hello!'
        module = result.get('module') or ''
    except Exception:
        reply, module = 'Hello!', ''
    return json.dumps({'reply': reply, 'module': module, 'ms': (time.perf_counter() - start) * 1000})
`

export type PybotTurnResult = {
  reply: string
  module: string
  ms: number
}

/** 启动 PyBot 交互式会话：只在开始时同步一次源码，之后每轮只调用 Python 函数 */
export const startPybotInteractive = async (
  io: ToolchainIO,
  options: { seed?: number } = {}
): Promise<void> => {
  if (!stateOf('python').installed) {
    throw new Error('PyBot 需要 Python 工具链，先执行 vm install python')
  }
  if (pybotSession) {
    return
  }
  const runtime = await ensurePythonRuntime(io)
  if (!runtime) {
    throw new Error('Python 运行时加载失败')
  }
  const roots = [PYBOT_ROOT, '/home/user', '/tmp']
  const { files, skipped } = collectFiles(io.fs, roots, PYBOT_SYNC_LIMIT)
  if (skipped > 0) {
    io.stderr(`pybot: 有 ${skipped} 个文件超过同步上限，可能影响模块加载\n`)
  }
  syncIntoPyodide(runtime.pyodide.FS, files)
  runtime.pyodide.runPython(PYBOT_BOOTSTRAP)
  if (options.seed !== undefined) {
    runtime.pyodide.runPython(`import random; random.seed(${Math.round(options.seed)})`)
  }
  pybotSession = { pyodide: runtime.pyodide, ready: true }
}

/** 交互式会话的一轮：返回回复、命中模块与耗时 */
export const pybotTurn = (text: string): PybotTurnResult => {
  if (!pybotSession) {
    throw new Error('PyBot 会话尚未启动')
  }
  const result = pybotSession.pyodide.runPython(
    `__nanovm_pybot_turn(${JSON.stringify(text)})`
  ) as unknown
  const parsed = JSON.parse(String(result)) as Partial<PybotTurnResult>
  return {
    reply: typeof parsed.reply === 'string' ? parsed.reply : 'Hello!',
    module: typeof parsed.module === 'string' ? parsed.module : '',
    ms: typeof parsed.ms === 'number' ? parsed.ms : 0,
  }
}

export const resetPybotInteractive = (): void => {
  pybotSession?.pyodide.runPython('__nanovm_pybot_reset()')
}

export const endPybotInteractive = (): void => {
  pybotSession = null
}

export const isPybotInteractive = (): boolean => pybotSession !== null

/**
 * 运行 PyBot：源码在 /opt/pybot，直接同步进 Pyodide 后按脚本执行。
 *
 * 普通 python3 的同步上限是 16MB，PyBot 有约 39MB / 528 个模块，所以单独放宽到
 * 64MB，并且只同步 PyBot 目录与当前目录，不回写（PyBot 不修改自己的源码）。
 */
const runPybot = async (
  io: ToolchainIO,
  argv: string[]
): Promise<{ code: number; error?: string }> => {
  if (!stateOf('python').installed) {
    return {
      code: 127,
      error: 'PyBot 需要 Python 工具链，先执行 vm install python（约 12MB）',
    }
  }
  const runtime = await ensurePythonRuntime(io)
  if (!runtime) {
    return { code: 1, error: 'Python 运行时加载失败' }
  }
  const roots = [PYBOT_ROOT, '/home/user', '/tmp']
  if (io.cwd && io.cwd !== '/') {
    roots.push(io.cwd)
  }
  const { files, skipped } = collectFiles(io.fs, roots, PYBOT_SYNC_LIMIT)
  if (skipped > 0) {
    io.stderr(`pybot: 有 ${skipped} 个文件超过同步上限，可能影响模块加载\n`)
  }
  const pyodide = runtime.pyodide
  attachPythonIO(io, pyodide, io.stdin)
  syncIntoPyodide(pyodide.FS, files)
  const runner = buildPythonRunner('script', {
    script: `${PYBOT_ROOT}/pybot.py`,
    code: '',
    argv: ['pybot', ...argv],
  })
  let exitCode = 0
  try {
    pyodide.runPython(runner)
    exitCode = readPythonExitCode(pyodide)
  } catch (error) {
    io.stderr(`pybot: ${error instanceof Error ? error.message : String(error)}\n`)
    exitCode = 1
  }
  return { code: exitCode }
}

const runPython = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  // pip 这个 applet 会把命令原样交给 python 工具链：pip install … → python -m pip install …
  if (argv[0] === 'pip') {
    return runPip(io, argv.slice(1))
  }
  const invocation = parsePythonArgs(argv)
  if (invocation.mode === 'version') {
    io.stdout(`Python ${pythonVersionLabel()}\n`)
    return { code: 0 }
  }
  if (invocation.mode === 'help') {
    if (invocation.unknown) {
      io.stderr(`python3: 未知参数 '${invocation.unknown}'\n`)
      return { code: 2 }
    }
    io.stdout(PYTHON_USAGE)
    return { code: 0 }
  }
  // -m 只认两个：pip（micropip）与 nanovm_serve（虚拟网络里的 WSGI 入口）
  let serve: ServeInvocation | null = null
  if (invocation.mode === 'module') {
    const moduleName = invocation.args[0] ?? ''
    if (moduleName === 'pip') {
      return runPip(io, invocation.args.slice(1))
    }
    const web = await loadPythonWeb()
    serve = web.parseServeInvocation(['-m', moduleName, ...invocation.args.slice(1)])
    if (!serve) {
      io.stderr(
        `python3: 不支持 -m ${moduleName || '（空模块名）'}，` +
          '只支持 -m pip 与 -m nanovm_serve\n'
      )
      return { code: 1 }
    }
  }

  let script: string | null = null
  let code = ''
  let mode: 'script' | 'code' | 'stdin' = 'code'
  let scriptArgs: string[] = invocation.args
  if (invocation.mode === 'script' && invocation.script) {
    script = resolvePath(io.cwd, invocation.script)
    const source = io.fs.readText(script)
    if (source === null) {
      io.stderr(
        `python3: can't open file '${invocation.script}': [Errno 2] No such file or directory\n`
      )
      return { code: 2 }
    }
    mode = 'script'
    code = source
  } else if (invocation.mode === 'stdin') {
    if (!io.stdin.trim()) {
      io.stderr('python3: 交互式 REPL 不支持，请用 python3 script.py 或 python3 -c "代码"\n')
      return { code: 1 }
    }
    mode = 'stdin'
    code = io.stdin
    scriptArgs = []
  } else {
    code = invocation.code ?? ''
  }

  const runtime = await ensurePythonRuntime(io)
  if (!runtime) {
    return { code: 1 }
  }

  const roots = pythonRoots(io, script)
  const { files, skipped } = collectFiles(io.fs, roots, SYNC_LIMIT_BYTES)
  if (skipped > 0) {
    io.stderr(`python3: 有 ${skipped} 个文件超过同步上限（16MB），Python 里读不到它们\n`)
  }
  const pyodide = runtime.pyodide
  // CGI 响应要原样回给虚拟网络，所以 serve 模式下先把 stdout 收集起来
  const cgiOutput: string[] | undefined = serve ? [] : undefined
  attachPythonIO(io, pyodide, io.stdin, cgiOutput)
  syncIntoPyodide(pyodide.FS, files)

  // nanovm 模块每个实例只注入一次；环境变量（NANOVM_HTTP_*）每次都同步
  let web: PythonWebModule | null = null
  try {
    web = await loadPythonWeb()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    io.stderr(`python3: nanovm 模块加载失败，-m nanovm_serve 不可用：${detail}\n`)
  }
  if (web) {
    ensurePythonWeb(pyodide, io, web)
  }

  const runnerArgv = [
    mode === 'script' ? (invocation.script ?? script ?? '') : mode === 'code' ? '-c' : '-',
    ...scriptArgs,
  ]
  let exitCode = 0
  try {
    if (serve) {
      if (!web) {
        io.stderr('python3: nanovm 模块没有注入成功，无法运行 WSGI 应用\n')
        return { code: 1 }
      }
      exitCode = web.runWsgiApp(pyodide, serve, { cwd: io.cwd })
      if (cgiOutput && cgiOutput.length > 0) {
        io.stdout(cgiOutput.join('\n'))
      }
    } else {
      pyodide.runPython(buildPythonRunner(mode, { script, code, argv: runnerArgv }))
      exitCode = readPythonExitCode(pyodide)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`python3: ${message}\n`)
    exitCode = 1
  } finally {
    syncBackFromPyodide(io.fs, files, roots, pyodide.FS)
  }
  if (io.signal?.aborted) {
    io.stderr('python3: 已被中断（Python 执行期间无法立刻打断，已跳过剩余代码）\n')
    return { code: 130 }
  }
  return { code: exitCode }
}

// ---------- Node.js ----------

const NODE_USAGE = [
  '用法：node [-v] [-e "代码"] [脚本.js] [参数...]',
  '',
  '浏览器内置的 JS 运行时（Web Worker 沙箱），支持 console / process /',
  "require('fs'|'path'|'os'|'util'|'events') / Buffer / module.exports。",
  '不支持 npm 包、ESM 的 import 语句与原生模块；fs 的异步 API 也不支持。',
  '',
].join('\n')

/** Node 沙箱能看到的目录：cwd、脚本目录与 /tmp */
const nodeRoots = (io: ToolchainIO, script: string | null): string[] => {
  const roots = new Set<string>(['/tmp'])
  if (io.cwd && io.cwd !== '/') {
    roots.add(io.cwd)
  }
  if (script && script.startsWith('/')) {
    roots.add(dirName(script))
  }
  return [...roots]
}

const applyNodeChanges = (fs: NanovmFS, files: Record<string, Uint8Array>, removed: string[]) => {
  for (const [path, bytes] of Object.entries(files)) {
    try {
      fs.mkdir(dirName(path), true)
      fs.write(path, bytes)
    } catch {
      // 容量不足时不打断命令本身的退出码
    }
  }
  for (const path of removed) {
    try {
      fs.remove(path)
    } catch {
      // 已经被删掉了
    }
  }
}

const runNodeCli = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  let code = ''
  let scriptPath = ''
  let scriptArgs: string[] = []
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '-v' || arg === '--version') {
      io.stdout(`v${NODE_VERSION}\n`)
      return { code: 0 }
    }
    if (arg === '-h' || arg === '--help') {
      io.stdout(NODE_USAGE)
      return { code: 0 }
    }
    if (arg === '-e' || arg === '--eval') {
      code = argv[index + 1] ?? ''
      scriptPath = '<eval>'
      scriptArgs = argv.slice(index + 2)
      break
    }
    if (arg === '-' || arg === '--') {
      code = io.stdin
      scriptPath = '<stdin>'
      scriptArgs = argv.slice(index + 1)
      break
    }
    if (arg.startsWith('-')) {
      io.stderr(`node: 不支持的参数 '${arg}'\n${NODE_USAGE}`)
      return { code: 9 }
    }
    scriptPath = resolvePath(io.cwd, arg)
    scriptArgs = argv.slice(index + 1)
    break
  }
  if (!scriptPath) {
    if (io.stdin.trim()) {
      code = io.stdin
      scriptPath = '<stdin>'
    } else {
      io.stderr(`node: 交互式 REPL 不支持，请用 node script.js 或 node -e "代码"\n`)
      return { code: 9 }
    }
  }
  if (!code) {
    if (!scriptPath.startsWith('<')) {
      const source = io.fs.readText(scriptPath)
      if (source === null) {
        io.stderr(`node: 找不到模块 '${scriptPath}'\n`)
        return { code: 1 }
      }
      // 真实 Node 的加载器会剥掉 hashbang；沙箱里的 new Function 不会，这里补一次
      code = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source
    } else {
      code = io.stdin
    }
  }
  const { files, skipped } = collectFiles(io.fs, nodeRoots(io, scriptPath), SYNC_LIMIT_BYTES)
  if (skipped > 0) {
    io.stderr(`node: 有 ${skipped} 个文件超过同步上限（16MB），脚本里读不到它们\n`)
  }
  const result = await runNode({
    code,
    scriptPath,
    argv: scriptArgs,
    env: io.env,
    cwd: io.cwd,
    // 虚拟网络（vm serve）的 CGI 请求体从 stdin 进 Node 沙箱
    stdin: io.stdin,
    files: Object.fromEntries(files),
    timeoutMs: nanoVMConfig().timeoutMs,
    signal: io.signal,
    onStdout: io.stdout,
    onStderr: io.stderr,
  })
  applyNodeChanges(io.fs, result.files, result.removed)
  return { code: result.code }
}

// ---------- Git ----------

const runGitCli = async (io: ToolchainIO, argv: string[]): Promise<{ code: number }> => {
  const code = await runGit(argv, {
    fs: io.fs,
    cwd: io.cwd,
    env: io.env,
    stdout: io.stdout,
    stderr: io.stderr,
    stdin: io.stdin,
  })
  return { code }
}

// ---------- 安装 / 卸载 ----------

/**
 * 安装（或启用）一个工具链。
 * onProgress 回调 0–1，UI 可以直接拿来画进度条；也可以订阅 usePackages 里的 progress。
 */
export const installToolchain = async (
  id: ToolchainId,
  onProgress?: (progress: number) => void
): Promise<{ ok: boolean; error?: string }> => {
  const current = stateOf(id)
  if (current.installed) {
    onProgress?.(1)
    return { ok: true }
  }
  if (usePackages.getState().busy) {
    return { ok: false, error: '另一个工具链正在安装，请稍后再试' }
  }
  usePackages.setState({ busy: id })
  patchState(id, { progress: 0, error: undefined })
  const report = (progress: number) => {
    patchState(id, { progress })
    onProgress?.(progress)
  }
  try {
    if (id === 'pybot') {
      await installPybot(report)
      patchState(id, {
        installed: true,
        version: META.pybot.version,
        progress: 1,
        error: undefined,
        sizeMB: META.pybot.sizeMB,
      })
    } else if (id === 'python') {
      const runtime = await loadPythonRuntime(report)
      patchState(id, {
        installed: true,
        version: runtime.version,
        progress: 1,
        error: undefined,
        sizeMB: META.python.sizeMB,
      })
    } else {
      const runtime = await runtimeOf(id)
      if (runtime) {
        // 需要下载的运行时：下载完成才算装好，进度由运行时的 load 上报
        const loaded = await runtime.load(report)
        patchState(id, {
          installed: true,
          version: loaded.version || META[id].version,
          progress: 1,
          error: undefined,
        })
      } else {
        // 内置运行时：安装只是「启用」
        report(0.5)
        patchState(id, {
          installed: true,
          version: META[id].version,
          progress: 1,
          error: undefined,
        })
        report(1)
      }
    }
    writeStored(usePackages.getState().states)
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const message =
      id === 'python'
        ? `下载 Python 运行时失败，需要联网（首次安装约 12MB）。${detail ? `原因：${detail}` : ''}`
        : RUNTIMES[id]
          ? `下载 ${META[id].label} 运行时失败，需要联网（约 ${META[id].sizeMB}MB）。${detail ? `原因：${detail}` : ''}`
          : `启用 ${META[id].label} 失败：${detail}`
    patchState(id, { progress: undefined, error: message })
    return { ok: false, error: message }
  } finally {
    usePackages.setState({ busy: null })
  }
}

/** 卸载：释放内存里的运行时，并记住「用户主动卸载过」 */
export const uninstallToolchain = async (id: ToolchainId): Promise<void> => {
  if (id === 'pybot') {
    try {
      vmFs.remove(PYBOT_ROOT, true)
      await vmFs.persist()
    } catch {
      // 目录不存在的重复卸载可以忽略
    }
  }
  if (id === 'python') {
    pythonRuntime = null
    pythonLoading = null
  }
  const runtime = await runtimeOf(id).catch(() => null)
  await runtime?.dispose?.()
  runtimeCache.delete(id)
  patchState(id, {
    installed: false,
    version: undefined,
    progress: undefined,
    error: undefined,
  })
  writeStored(usePackages.getState().states)
}

// ---------- 给 shell / 应用集用的门面 ----------

/** 执行工具链命令：argv 不含命令名，输出直接写 io */
export const createToolchainHost = (): ToolchainHost => ({
  installed: (id) => stateOf(id).installed,
  install: (id, onProgress) => installToolchain(id, onProgress),
  run: async (id, argv, io) => {
    const state = stateOf(id)
    if (!state.installed) {
      return {
        code: 127,
        error: `${state.label} 未安装，执行 vm install ${id} 可以按需安装`,
      }
    }
    try {
      if (id === 'python') {
        return await runPython(io, argv)
      }
      if (id === 'pybot') {
        return await runPybot(io, argv)
      }
      if (id === 'node') {
        return await runNodeCli(io, argv)
      }
      if (id === 'git') {
        return await runGitCli(io, argv)
      }
      const runtime = await runtimeOf(id)
      if (!runtime) {
        return { code: 127, error: `${state.label} 没有可执行入口，请用 vm list 查看可用工具链` }
      }
      return await runtime.run(argv, io)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      io.stderr(`${id}: ${message}\n`)
      return { code: 1, error: message }
    }
  },
})
