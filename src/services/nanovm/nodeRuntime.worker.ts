/**
 * Node.js 兼容运行时的沙箱内核。
 *
 * 浏览器里没有真正的 Node，这里用 Function 构造函数搭一个「够用」的子集：
 * console / process / require('fs'|'path'|'http'|'url'|'ws'|...) / Buffer /
 * module.exports / __dirname / __filename / 定时器。脚本改过的文件最后以差分的形式回传
 * 主线程，由主线程写回 NanoVM 的虚拟文件系统。
 *
 * `http` / `https` / `ws` 没有真实 socket，走「虚拟网络 + CGI 单请求」：宿主用环境变量
 * 与 stdin 把请求塞进来，脚本把 CGI 响应写 stdout；细节见下面的虚拟网络模块一节。
 *
 * 这个文件被两条路径共用：
 * - 有 Worker 时它就是 Worker 入口（检测到 postMessage 才注册消息处理）；
 * - 拿不到 Worker 时主线程回落到 executeNode，直接跑同一套沙箱。
 * 因此这里不能碰 DOM、OPFS 与 zustand，也不 import 项目里的其他模块。
 */

/** 沙箱里报告的 Node 版本号，仅用于 `node -v` 与 `process.version` 展示 */
export const NODE_VERSION = '22.0.0-nanovm'

/** 沙箱里报告的运行平台，脚本可以用它判断「不是真 Node」 */
export const NODE_PLATFORM = 'nanovm'

/** 沙箱内单个脚本的默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 15_000

/** 输出攒够这么多字符或遇到换行就推给主线程，避免一条条消息刷屏 */
const SINK_FLUSH_CHARS = 8 * 1024

export type SandboxFileMap = Record<string, Uint8Array>

/** 主线程 → Worker 的执行请求 */
export type NodeSandboxRequest = {
  type: 'run'
  code: string
  scriptPath: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  files: SandboxFileMap
  /** 标准输入：虚拟网络 CGI 请求体从 stdin 来，普通脚本读不到也不影响 */
  stdin: string
  timeoutMs: number
}

/** Worker → 主线程的消息 */
export type NodeSandboxMessage =
  | { type: 'stdout'; text: string }
  | { type: 'stderr'; text: string }
  | {
      type: 'done'
      code: number
      files: SandboxFileMap
      removed: string[]
      timedOut: boolean
      aborted: boolean
    }
  | { type: 'error'; message: string }

export type SandboxOptions = {
  code: string
  /** 写进 process.argv[1] 与 __filename 的路径 */
  scriptPath: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  files: SandboxFileMap
  /** 标准输入，CGI 模式下就是请求体；默认空串 */
  stdin?: string
  timeoutMs?: number
  onStdout: (text: string) => void
  onStderr: (text: string) => void
  /** 主线程回落路径用它响应 AbortSignal；Worker 里由主线程 terminate 代替 */
  shouldAbort?: () => boolean
}

export type SandboxOutcome = {
  code: number
  /** 改动过或新建的文件 */
  files: SandboxFileMap
  /** 被删掉的文件 */
  removed: string[]
  timedOut: boolean
  aborted: boolean
}

// ---------- 路径 ----------

/** 折叠重复斜杠与 . / ..，返回绝对路径（根为 /） */
const normalizePath = (input: string): string => {
  const parts: string[] = []
  for (const part of input.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

const isAbsolutePath = (input: string): boolean => input.startsWith('/')

const resolvePath = (cwd: string, input: string): string =>
  isAbsolutePath(input) ? normalizePath(input) : normalizePath(`${cwd}/${input}`)

const dirNameOf = (path: string): string => {
  const normalized = normalizePath(path)
  if (normalized === '/') {
    return '/'
  }
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

const baseNameOf = (path: string): string => {
  const normalized = normalizePath(path)
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1)
}

const joinPaths = (base: string, ...parts: string[]): string => {
  let result = base
  for (const part of parts) {
    result = part.startsWith('/') ? part : `${result}/${part}`
  }
  return normalizePath(result)
}

/** 与 path.join 一致：只拼接与折叠，不引入 cwd，也不强制绝对路径 */
const joinRelative = (parts: string[]): string => {
  const joined = parts.filter((part) => part !== '').join('/')
  const absolute = joined.startsWith('/')
  const segments: string[] = []
  for (const part of joined.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!absolute) {
        segments.push('..')
      }
      continue
    }
    segments.push(part)
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`
}

// ---------- 编码 ----------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const utf8Encode = (text: string): Uint8Array => encoder.encode(text)

/** 宽松解码：二进制内容解不出来也不抛错，尽量给出可读文本 */
const utf8Decode = (bytes: Uint8Array): string => decoder.decode(bytes)

const latin1Decode = (bytes: Uint8Array): string => {
  let text = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    text += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return text
}

const latin1Encode = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff
  }
  return bytes
}

const hexDecode = (text: string): Uint8Array => {
  const clean = text.replace(/[^0-9a-fA-F]/g, '')
  const length = Math.floor(clean.length / 2)
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const hexEncode = (bytes: Uint8Array): string => {
  let text = ''
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0')
  }
  return text
}

const base64Encode = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

const base64Decode = (text: string): Uint8Array => {
  try {
    const binary = atob(text.replace(/[^A-Za-z0-9+/=]/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return new Uint8Array(0)
  }
}

type BufferEncoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'latin1' | 'binary' | 'ascii'

const encodeWith = (text: string, encoding: string = 'utf8'): Uint8Array => {
  const kind = encoding.toLowerCase() as BufferEncoding
  if (kind === 'hex') {
    return hexDecode(text)
  }
  if (kind === 'base64') {
    return base64Decode(text)
  }
  if (kind === 'latin1' || kind === 'binary' || kind === 'ascii') {
    return latin1Encode(text)
  }
  return utf8Encode(text)
}

const decodeWith = (bytes: Uint8Array, encoding: string = 'utf8'): string => {
  const kind = encoding.toLowerCase() as BufferEncoding
  if (kind === 'hex') {
    return hexEncode(bytes)
  }
  if (kind === 'base64') {
    return base64Encode(bytes)
  }
  if (kind === 'latin1' || kind === 'binary' || kind === 'ascii') {
    return latin1Decode(bytes)
  }
  return utf8Decode(bytes)
}

// ---------- Buffer ----------

/** 带 Node 风格 toString 的 Uint8Array 子类 */
class VmBuffer extends Uint8Array {
  override toString(encoding: string = 'utf8'): string {
    return decodeWith(this, encoding)
  }

  equals(other: Uint8Array): boolean {
    if (this.length !== other.length) {
      return false
    }
    for (let index = 0; index < this.length; index += 1) {
      if (this[index] !== other[index]) {
        return false
      }
    }
    return true
  }

  write(text: string, offset = 0, encoding: string = 'utf8'): number {
    const bytes = encodeWith(text, encoding)
    const length = Math.min(bytes.length, this.length - offset)
    this.set(bytes.subarray(0, length), offset)
    return length
  }

  toJSON(): { type: 'Buffer'; data: number[] } {
    return { type: 'Buffer', data: [...this] }
  }
}

/** 把普通 Uint8Array 换成 VmBuffer（不复制内容） */
const asBuffer = (bytes: Uint8Array): VmBuffer =>
  Object.setPrototypeOf(bytes, VmBuffer.prototype) as VmBuffer

const toBytes = (input: unknown): Uint8Array => {
  if (input instanceof Uint8Array) {
    return input
  }
  if (typeof input === 'string') {
    return utf8Encode(input)
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input.map((value) => Number(value) & 0xff))
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input)
  }
  throw new TypeError('The first argument must be of type string, Buffer, or ArrayBuffer')
}

const BufferApi = {
  from: (input: unknown, encodingOrOffset?: string | number, length?: number): VmBuffer => {
    if (typeof input === 'string') {
      return asBuffer(
        encodeWith(input, typeof encodingOrOffset === 'string' ? encodingOrOffset : 'utf8')
      )
    }
    if (input instanceof ArrayBuffer) {
      const offset = typeof encodingOrOffset === 'number' ? encodingOrOffset : 0
      const size = typeof length === 'number' ? length : input.byteLength - offset
      return asBuffer(new Uint8Array(input, offset, size))
    }
    return asBuffer(toBytes(input))
  },
  alloc: (size: number, fill?: string | number, encoding?: string): VmBuffer => {
    const bytes = new VmBuffer(Math.max(0, Math.trunc(size)))
    if (typeof fill === 'string' && fill) {
      const pattern = encodeWith(fill, encoding)
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = pattern[index % pattern.length]
      }
    } else if (typeof fill === 'number') {
      bytes.fill(fill & 0xff)
    }
    return bytes
  },
  allocUnsafe: (size: number): VmBuffer => new VmBuffer(Math.max(0, Math.trunc(size))),
  concat: (list: Uint8Array[], totalLength?: number): VmBuffer => {
    const size =
      typeof totalLength === 'number'
        ? totalLength
        : list.reduce((sum, item) => sum + item.byteLength, 0)
    const bytes = new VmBuffer(Math.max(0, Math.trunc(size)))
    let offset = 0
    for (const item of list) {
      const rest = bytes.length - offset
      if (rest <= 0) {
        break
      }
      bytes.set(item.subarray(0, rest), offset)
      offset += item.byteLength
    }
    return bytes
  },
  isBuffer: (value: unknown): boolean => value instanceof VmBuffer,
  byteLength: (input: unknown, encoding = 'utf8'): number =>
    typeof input === 'string' ? encodeWith(input, encoding).byteLength : toBytes(input).byteLength,
  isEncoding: (encoding: string): boolean =>
    ['utf8', 'utf-8', 'hex', 'base64', 'latin1', 'binary', 'ascii'].includes(
      encoding.toLowerCase()
    ),
}

// ---------- 错误 ----------

type NodeError = Error & { code: string; path?: string; syscall?: string; errno?: number }

const ERRNO_MESSAGE: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  EEXIST: 'file already exists',
  ENOTEMPTY: 'directory not empty',
  EPERM: 'operation not permitted',
  EACCES: 'permission denied',
  EINVAL: 'invalid argument',
}

const fsError = (code: string, syscall: string, path: string): NodeError => {
  const error = new Error(
    `${code}: ${ERRNO_MESSAGE[code] ?? 'filesystem error'}, ${syscall} '${path}'`
  ) as NodeError
  error.code = code
  error.syscall = syscall
  error.path = path
  return error
}

/** process.exit() 用它把控制流从用户脚本里抛出来 */
class ExitSignal extends Error {
  readonly code: number

  constructor(code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitSignal'
    this.code = code
  }
}

/** 退出码按 POSIX 习惯截断到 0–255 */
const normalizeExitCode = (code: number): number => {
  if (!Number.isFinite(code)) {
    return 0
  }
  const value = Math.trunc(code)
  return ((value % 256) + 256) % 256
}

// ---------- 虚拟文件系统 ----------

type StatResult = {
  dev: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  size: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
}

/** 沙箱内部的只读/可写文件表，按绝对路径存字节 */
class SandboxFs {
  private files = new Map<string, Uint8Array>()
  private dirs = new Set<string>(['/'])
  private written = new Set<string>()
  private deleted = new Set<string>()

  constructor(files: SandboxFileMap) {
    for (const [path, bytes] of Object.entries(files)) {
      this.files.set(normalizePath(path), new Uint8Array(bytes))
      this.rememberDirs(normalizePath(path))
    }
  }

  private rememberDirs = (path: string) => {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (let index = 0; index < segments.length - 1; index += 1) {
      current += `/${segments[index]}`
      this.dirs.add(current)
    }
  }

  writtenPaths = (): string[] => [...this.written]

  deletedPaths = (): string[] => [...this.deleted]

  hasFile = (path: string): boolean => this.files.has(path)

  hasDir = (path: string): boolean => this.dirs.has(path)

  peek = (path: string): Uint8Array | undefined => this.files.get(path)

  readFile = (path: string): Uint8Array => {
    const bytes = this.files.get(path)
    if (!bytes) {
      if (this.dirs.has(path)) {
        throw fsError('EISDIR', 'read', path)
      }
      throw fsError('ENOENT', 'open', path)
    }
    return new Uint8Array(bytes)
  }

  writeFile = (path: string, data: Uint8Array) => {
    if (this.dirs.has(path)) {
      throw fsError('EISDIR', 'open', path)
    }
    const parent = dirNameOf(path)
    if (!this.dirs.has(parent)) {
      throw fsError('ENOENT', 'open', path)
    }
    this.files.set(path, new Uint8Array(data))
    this.written.add(path)
    this.deleted.delete(path)
  }

  appendFile = (path: string, data: Uint8Array) => {
    const previous = this.files.get(path) ?? new Uint8Array(0)
    const merged = new Uint8Array(previous.byteLength + data.byteLength)
    merged.set(previous, 0)
    merged.set(data, previous.byteLength)
    this.writeFile(path, merged)
  }

  unlink = (path: string) => {
    if (this.dirs.has(path)) {
      throw fsError('EISDIR', 'unlink', path)
    }
    if (!this.files.has(path)) {
      throw fsError('ENOENT', 'unlink', path)
    }
    this.files.delete(path)
    this.written.delete(path)
    this.deleted.add(path)
  }

  mkdir = (path: string, recursive = false) => {
    if (this.files.has(path)) {
      throw fsError('EEXIST', 'mkdir', path)
    }
    if (this.dirs.has(path)) {
      if (recursive) {
        return
      }
      throw fsError('EEXIST', 'mkdir', path)
    }
    if (recursive) {
      const segments = path.split('/').filter(Boolean)
      let current = ''
      for (const segment of segments) {
        current += `/${segment}`
        if (this.files.has(current)) {
          throw fsError('ENOTDIR', 'mkdir', current)
        }
        this.dirs.add(current)
      }
      return
    }
    const parent = dirNameOf(path)
    if (!this.dirs.has(parent)) {
      throw fsError('ENOENT', 'mkdir', path)
    }
    this.dirs.add(path)
  }

  removeTree = (path: string, recursive: boolean) => {
    if (this.files.has(path)) {
      this.unlink(path)
      return
    }
    if (!this.dirs.has(path)) {
      throw fsError('ENOENT', 'rm', path)
    }
    const children = this.list(path)
    if (children.length > 0 && !recursive) {
      throw fsError('ENOTEMPTY', 'rm', path)
    }
    const prefix = path === '/' ? '/' : `${path}/`
    for (const entry of [...this.files.keys()]) {
      if (entry === path || entry.startsWith(prefix)) {
        this.files.delete(entry)
        this.written.delete(entry)
        this.deleted.add(entry)
      }
    }
    for (const entry of [...this.dirs]) {
      if (entry === path || entry.startsWith(prefix)) {
        this.dirs.delete(entry)
      }
    }
  }

  /** 列目录下的名字（文件与目录都有） */
  list = (path: string): string[] => {
    if (!this.dirs.has(path)) {
      if (this.files.has(path)) {
        throw fsError('ENOTDIR', 'scandir', path)
      }
      throw fsError('ENOENT', 'scandir', path)
    }
    const prefix = path === '/' ? '/' : `${path}/`
    const names = new Set<string>()
    for (const entry of this.files.keys()) {
      if (entry.startsWith(prefix)) {
        const rest = entry.slice(prefix.length)
        if (rest && !rest.includes('/')) {
          names.add(rest)
        }
      }
    }
    for (const entry of this.dirs) {
      if (entry !== path && entry.startsWith(prefix)) {
        const rest = entry.slice(prefix.length)
        if (rest && !rest.includes('/')) {
          names.add(rest)
        }
      }
    }
    return [...names].sort()
  }

  stat = (path: string): StatResult => {
    const size = this.files.get(path)?.byteLength ?? 0
    const isFile = this.files.has(path)
    const isDirectory = this.dirs.has(path)
    if (!isFile && !isDirectory) {
      throw fsError('ENOENT', 'stat', path)
    }
    const now = Date.now()
    return {
      dev: 1,
      mode: isDirectory ? 0o40755 : 0o100644,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
      atime: new Date(now),
      mtime: new Date(now),
      ctime: new Date(now),
      birthtime: new Date(now),
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      isSymbolicLink: () => false,
    }
  }

  rename = (from: string, to: string) => {
    const bytes = this.readFile(from)
    this.writeFile(to, bytes)
    this.files.delete(from)
    this.written.delete(from)
    this.deleted.add(from)
  }
}

// ---------- 输出 ----------

type Sink = {
  write: (text: string) => void
  flush: () => void
}

const createSink = (emit: (text: string) => void): Sink => {
  let buffer = ''
  const sink: Sink = {
    write: (text: string) => {
      buffer += text
      if (buffer.length >= SINK_FLUSH_CHARS || buffer.endsWith('\n')) {
        emit(buffer)
        buffer = ''
      }
    },
    flush: () => {
      if (buffer) {
        emit(buffer)
        buffer = ''
      }
    },
  }
  return sink
}

// ---------- 值格式化（console） ----------

const inspectValue = (value: unknown, depth = 0): string => {
  if (typeof value === 'string') {
    return depth === 0 ? value : `'${value}'`
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'undefined') {
    return 'undefined'
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'function') {
    const named = value.name || 'anonymous'
    return `[Function: ${named}]`
  }
  if (typeof value === 'symbol') {
    return value.toString()
  }
  if (value instanceof Error) {
    return value.stack
      ? value.stack.split('\n').slice(0, 4).join('\n')
      : `${value.name}: ${value.message}`
  }
  if (value instanceof Uint8Array) {
    const head = [...value.subarray(0, 24)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ')
    return value.byteLength > 24 ? `<Buffer ${head} ...>` : `<Buffer ${head}>`
  }
  if (depth >= 3) {
    return Array.isArray(value) ? '[Array]' : '[Object]'
  }
  if (Array.isArray(value)) {
    return `[ ${value.map((item) => inspectValue(item, depth + 1)).join(', ')} ]`
  }
  if (value instanceof Map) {
    return `Map(${value.size}) { ${[...value.entries()]
      .map(([key, item]) => `${inspectValue(key, depth + 1)} => ${inspectValue(item, depth + 1)}`)
      .join(', ')} }`
  }
  if (value instanceof Set) {
    return `Set(${value.size}) { ${[...value.values()]
      .map((item) => inspectValue(item, depth + 1))
      .join(', ')} }`
  }
  const record = value as Record<string, unknown>
  const entries = Object.keys(record).map(
    (key) => `${key}: ${inspectValue(record[key], depth + 1)}`
  )
  return `{ ${entries.join(', ')} }`
}

/** 支持 %s %d %i %f %j %o %O %% 的 console 格式化，其余参数按空格拼接 */
const formatArgs = (args: unknown[]): string => {
  if (args.length === 0) {
    return ''
  }
  const first = args[0]
  if (typeof first !== 'string' || !first.includes('%')) {
    return args.map((value) => inspectValue(value)).join(' ')
  }
  let rest = 1
  const text = first.replace(/%([sdifjjoO%])/g, (match, token: string) => {
    if (token === '%') {
      return '%'
    }
    if (rest >= args.length) {
      return match
    }
    const value = args[rest]
    rest += 1
    if (token === 'd' || token === 'i') {
      return String(Number(value))
    }
    if (token === 'f') {
      return String(Number(value))
    }
    if (token === 'j') {
      try {
        return JSON.stringify(value) ?? String(value)
      } catch {
        return '[Circular]'
      }
    }
    if (token === 'o' || token === 'O') {
      return inspectValue(value)
    }
    return inspectValue(value)
  })
  const tail = args.slice(rest).map((value) => inspectValue(value))
  return tail.length > 0 ? `${text} ${tail.join(' ')}` : text
}

// ---------- 定时器 ----------

class TimerRegistry {
  private timeouts = new Map<number, ReturnType<typeof setTimeout>>()
  private intervals = new Map<number, ReturnType<typeof setInterval>>()
  private nextId = 1
  private onError: (error: unknown) => void

  constructor(onError: (error: unknown) => void) {
    this.onError = onError
  }

  setTimeout = (callback: unknown, delay = 0, ...args: unknown[]): number => {
    const id = this.nextId
    this.nextId += 1
    if (typeof callback !== 'function') {
      return id
    }
    const handle = setTimeout(
      () => {
        this.timeouts.delete(id)
        try {
          ;(callback as (...params: unknown[]) => void)(...args)
        } catch (error) {
          // 定时器里的异常在真 Node 里会让进程非零退出，这里同样上报
          this.onError(error)
        }
      },
      Math.max(0, Number(delay) || 0)
    )
    this.timeouts.set(id, handle)
    return id
  }

  clearTimeout = (id: unknown): void => {
    const handle = this.timeouts.get(Number(id))
    if (handle !== undefined) {
      clearTimeout(handle)
      this.timeouts.delete(Number(id))
    }
  }

  setInterval = (callback: unknown, delay = 0, ...args: unknown[]): number => {
    const id = this.nextId
    this.nextId += 1
    if (typeof callback !== 'function') {
      return id
    }
    const handle = setInterval(
      () => {
        try {
          ;(callback as (...params: unknown[]) => void)(...args)
        } catch (error) {
          this.onError(error)
        }
      },
      Math.max(1, Number(delay) || 0)
    )
    this.intervals.set(id, handle)
    return id
  }

  clearInterval = (id: unknown): void => {
    const handle = this.intervals.get(Number(id))
    if (handle !== undefined) {
      clearInterval(handle)
      this.intervals.delete(Number(id))
    }
  }

  clearAll = (): void => {
    for (const handle of this.timeouts.values()) {
      clearTimeout(handle)
    }
    for (const handle of this.intervals.values()) {
      clearInterval(handle)
    }
    this.timeouts.clear()
    this.intervals.clear()
  }

  /**
   * 等脚本里挂着的 setTimeout 跑完。
   * setInterval 不算「还在跑」——否则任何定时器都会把脚本永远挂住。
   */
  drain = async (
    deadline: number,
    shouldAbort: () => boolean
  ): Promise<'idle' | 'timeout' | 'aborted'> => {
    while (this.timeouts.size > 0) {
      if (shouldAbort()) {
        return 'aborted'
      }
      if (Date.now() > deadline) {
        return 'timeout'
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 4)
      })
    }
    if (shouldAbort()) {
      return 'aborted'
    }
    // 让最后一批微任务（nextTick / Promise）跑完再收尾
    await Promise.resolve()
    return 'idle'
  }
}

// ---------- 模块 ----------

const createPathModule = (getCwd: () => string) => {
  const extname = (path: string): string => {
    const name = baseNameOf(path)
    const index = name.lastIndexOf('.')
    if (index <= 0) {
      return ''
    }
    return name.slice(index)
  }
  const basename = (path: string, ext?: string): string => {
    const name = baseNameOf(path)
    if (ext && name.endsWith(ext) && name !== ext) {
      return name.slice(0, -ext.length)
    }
    return name
  }
  const relative = (from: string, to: string): string => {
    const source = normalizePath(from).split('/').filter(Boolean)
    const target = normalizePath(to).split('/').filter(Boolean)
    let common = 0
    while (common < source.length && common < target.length && source[common] === target[common]) {
      common += 1
    }
    const up = source.slice(common).map(() => '..')
    return [...up, ...target.slice(common)].join('/') || ''
  }
  const pathModule = {
    sep: '/',
    delimiter: ':',
    posix: null as unknown,
    join: (...parts: string[]): string => joinRelative(parts),
    resolve: (...parts: string[]): string => {
      let result = ''
      for (const part of parts) {
        result = isAbsolutePath(part) ? part : `${result}/${part}`
      }
      return result ? resolvePath(getCwd(), result) : getCwd()
    },
    normalize: (path: string): string => normalizePath(path),
    isAbsolute: (path: string): boolean => isAbsolutePath(path),
    basename,
    dirname: (path: string): string => dirNameOf(path),
    extname,
    relative,
    parse: (path: string) => {
      const dir = dirNameOf(path)
      const base = baseNameOf(path)
      const ext = extname(path)
      return { root: '/', dir, base, ext, name: ext ? base.slice(0, -ext.length) : base }
    },
  }
  pathModule.posix = pathModule
  return pathModule
}

type FsModuleOptions = {
  fs: SandboxFs
  getCwd: () => string
}

const createFsModule = ({ fs, getCwd }: FsModuleOptions) => {
  const withEncoding = (bytes: Uint8Array, encoding?: string): string | Uint8Array =>
    encoding ? decodeWith(bytes, encoding) : asBuffer(bytes)

  const readFileSync = (
    path: string,
    options?: string | { encoding?: string }
  ): string | Uint8Array => {
    const encoding = typeof options === 'string' ? options : options?.encoding
    return withEncoding(fs.readFile(resolvePath(getCwd(), path)), encoding)
  }

  const writeFileSync = (
    path: string,
    data: unknown,
    options?: string | { encoding?: string }
  ): void => {
    const encoding = typeof options === 'string' ? options : options?.encoding
    const bytes = typeof data === 'string' ? encodeWith(data, encoding) : toBytes(data)
    fs.writeFile(resolvePath(getCwd(), path), bytes)
  }

  const mkdirSync = (path: string, options?: { recursive?: boolean } | number): void => {
    const recursive =
      typeof options === 'object' && options !== null ? options.recursive === true : false
    fs.mkdir(resolvePath(getCwd(), path), recursive)
  }

  const rmSync = (path: string, options?: { recursive?: boolean; force?: boolean }): void => {
    const target = resolvePath(getCwd(), path)
    const recursive = options?.recursive === true
    try {
      fs.removeTree(target, recursive)
    } catch (error) {
      if (options?.force === true && (error as NodeError).code === 'ENOENT') {
        return
      }
      throw error
    }
  }

  return {
    readFileSync,
    writeFileSync,
    appendFileSync: (
      path: string,
      data: unknown,
      options?: string | { encoding?: string }
    ): void => {
      const encoding = typeof options === 'string' ? options : options?.encoding
      const bytes = typeof data === 'string' ? encodeWith(data, encoding) : toBytes(data)
      fs.appendFile(resolvePath(getCwd(), path), bytes)
    },
    readdirSync: (path: string, options?: { withFileTypes?: boolean }): unknown[] => {
      const names = fs.list(resolvePath(getCwd(), path))
      if (options?.withFileTypes !== true) {
        return names
      }
      const base = resolvePath(getCwd(), path)
      return names.map((name) => {
        const stat = fs.stat(joinPaths(base, name))
        return { name, isFile: stat.isFile, isDirectory: stat.isDirectory }
      })
    },
    existsSync: (path: string): boolean => {
      const target = resolvePath(getCwd(), path)
      return fs.hasFile(target) || fs.hasDir(target)
    },
    statSync: (path: string) => fs.stat(resolvePath(getCwd(), path)),
    lstatSync: (path: string) => fs.stat(resolvePath(getCwd(), path)),
    unlinkSync: (path: string): void => fs.unlink(resolvePath(getCwd(), path)),
    mkdirSync,
    mkdtempSync: (prefix: string): string => {
      const base = resolvePath(getCwd(), prefix)
      const target = `${base}-${Math.random().toString(36).slice(2, 8)}`
      fs.mkdir(target, true)
      return target
    },
    rmSync,
    rmdirSync: (path: string): void => fs.removeTree(resolvePath(getCwd(), path), false),
    renameSync: (from: string, to: string): void =>
      fs.rename(resolvePath(getCwd(), from), resolvePath(getCwd(), to)),
    copyFileSync: (from: string, to: string): void =>
      fs.writeFile(resolvePath(getCwd(), to), fs.readFile(resolvePath(getCwd(), from))),
    realpathSync: (path: string): string => resolvePath(getCwd(), path),
    createReadStream: () => {
      throw new Error('fs.createReadStream 不在 NanoVM 的 Node 子集里，请用 readFileSync')
    },
    createWriteStream: () => {
      throw new Error('fs.createWriteStream 不在 NanoVM 的 Node 子集里，请用 writeFileSync')
    },
    promises: null as unknown,
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  }
}

// ---------- 虚拟网络：http / https / ws / url / querystring ----------

/**
 * NanoVM 没有真实 socket。`vm serve <端口> "node app.js"` 会把命令注册成虚拟服务，
 * 之后每个 HTTP 请求都被当作一次 CGI 程序执行：请求信息走环境变量与 stdin 进来，
 * 响应按 CGI 头 + 正文写 stdout。这一节实现 http / https 的服务端与客户端、url、
 * querystring，以及 WebSocket 的单消息模式（ws）。
 *
 * CGI 模式（NANOVM_HTTP=1 / NANOVM_WS=1）下 stdout 是响应本体，所以 console 的
 * 输出必须转走 stderr；这一点在 executeNode 里按环境变量统一处理。
 */

/** 虚拟网络模块共用的依赖：请求体、两个输出流、定时器与退出入口 */
type VirtualNetOptions = {
  env: Record<string, string>
  stdin: string
  stdout: Sink
  stderr: Sink
  timers: TimerRegistry
  exit: (code: number) => never
}

/** 常用状态码文案：http.STATUS_CODES 与 CGI 的默认 Status 行都用它 */
const HTTP_STATUS_CODES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'TRACE',
  'CONNECT',
]

/** 非 CGI 模式下 listen 的统一提示 */
const VIRTUAL_NETWORK_HINT =
  'NanoVM: 监听端口需要虚拟网络，请用 vm serve <端口> "node app.js" 注册服务'

/** 只保留错误类型与消息：CGI 兜底响应与 stderr 提示都用它，不暴露沙箱内部栈 */
const describeThrown = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : inspectValue(error)

/**
 * 用户回调里调用 process.exit() 会抛 ExitSignal。原生 fetch / WebSocket 的
 * 回调不在沙箱的定时器里，直接抛会变成未捕获异常；这里转交给定时器统一收尾。
 */
const quarantineThrow = (timers: TimerRegistry, run: () => void): void => {
  try {
    run()
  } catch (error) {
    timers.setTimeout(() => {
      throw error
    }, 0)
  }
}

/** 请求体这类流事件：注册监听时把 stdin 里的内容推出去 */
const STREAM_EVENTS = ['data', 'end', 'readable', 'close', 'error', 'aborted']

/** 极简事件发射器：http / ws 的各种对象共用 */
class SandboxEmitter {
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>()

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  addListener(event: string, handler: (...args: unknown[]) => void): this {
    return this.on(event, handler)
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper)
      handler(...args)
    }
    return this.on(event, wrapper)
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event)
    if (!list) {
      return this
    }
    const next = list.filter((item) => item !== handler)
    if (next.length > 0) {
      this.handlers.set(event, next)
    } else {
      this.handlers.delete(event)
    }
    return this
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): this {
    return this.off(event, handler)
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) {
      this.handlers.clear()
    } else {
      this.handlers.delete(event)
    }
    return this
  }

  listeners(event: string): ((...args: unknown[]) => void)[] {
    return [...(this.handlers.get(event) ?? [])]
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this.handlers.get(event)
    if (!list || list.length === 0) {
      return false
    }
    for (const handler of [...list]) {
      handler(...args)
    }
    return true
  }
}

// ---------- 虚拟网络：头部与 CGI 工具 ----------

type HeaderEntry = { name: string; values: string[] }

type HeaderMap = Map<string, HeaderEntry>

const setHeaderValue = (headers: HeaderMap, name: string, value: unknown): void => {
  const values = Array.isArray(value) ? value.map((item) => String(item)) : [String(value)]
  headers.set(name.toLowerCase(), { name, values })
}

const appendHeaderValue = (headers: HeaderMap, name: string, value: unknown): void => {
  const key = name.toLowerCase()
  const values = Array.isArray(value) ? value.map((item) => String(item)) : [String(value)]
  const existing = headers.get(key)
  if (existing) {
    existing.values.push(...values)
    return
  }
  headers.set(key, { name, values })
}

const getHeaderValue = (headers: HeaderMap, name: string): string | string[] | undefined => {
  const entry = headers.get(name.toLowerCase())
  if (!entry) {
    return undefined
  }
  return entry.values.length === 1 ? entry.values[0] : [...entry.values]
}

/** 解析宿主塞进 NANOVM_HTTP_HEADERS 的 JSON；坏 JSON 只提示一次，不中断请求 */
const parseCgiHeaders = (raw: string | undefined, stderr: Sink): HeaderMap => {
  const headers: HeaderMap = new Map()
  const text = (raw ?? '').trim()
  if (!text) {
    return headers
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        setHeaderValue(headers, name, value)
      }
    }
  } catch {
    stderr.write('NanoVM: NANOVM_HTTP_HEADERS 不是合法 JSON，已按请求头为空处理\n')
  }
  return headers
}

/** 让沙箱在 fetch / WebSocket 这类「不靠定时器的异步」结束前保持存活 */
type ActivityTracker = { begin: () => void; done: () => void }

const createActivityTracker = (timers: TimerRegistry): ActivityTracker => {
  let pending = 0
  let polling = false
  const poll = (): void => {
    timers.setTimeout(() => {
      if (pending > 0) {
        poll()
      } else {
        polling = false
      }
    }, 8)
  }
  return {
    begin: () => {
      pending += 1
      if (!polling) {
        polling = true
        poll()
      }
    },
    done: () => {
      pending = Math.max(0, pending - 1)
    },
  }
}

// ---------- 虚拟网络：IncomingMessage ----------

type IncomingMessageInit = {
  method?: string
  url?: string
  headers: HeaderMap
  body: string
  timers: TimerRegistry
}

/**
 * 请求对象：数据一次性从 stdin 来，因此没有真正的流。
 * 监听 data / end 时把整个请求体当一个 chunk 推出去，end 在下一个定时器里触发，
 * 与真实 Node 的「事件在异步里到达」保持一致；body 为空也会触发 end。
 */
class IncomingMessage extends SandboxEmitter {
  method: string
  url: string
  headers: Record<string, string>
  rawHeaders: string[]
  httpVersion = '1.1'
  httpVersionMajor = 1
  httpVersionMinor = 1
  complete = true
  aborted = false
  readable = true
  socket: Record<string, unknown>
  connection: Record<string, unknown>
  private body: string
  private timers: TimerRegistry
  private encoding: string | null = null
  private scheduled = false
  private delivered = false

  constructor(init: IncomingMessageInit) {
    super()
    this.method = init.method ?? 'GET'
    this.url = init.url ?? '/'
    this.headers = {}
    this.rawHeaders = []
    for (const entry of init.headers.values()) {
      this.headers[entry.name.toLowerCase()] = entry.values.join(', ')
      for (const value of entry.values) {
        this.rawHeaders.push(entry.name, value)
      }
    }
    this.body = init.body
    this.timers = init.timers
    this.socket = {
      remoteAddress: '127.0.0.1',
      remoteFamily: 'IPv4',
      remotePort: 0,
      encrypted: false,
    }
    this.connection = this.socket
  }

  setEncoding(encoding: string = 'utf8'): this {
    this.encoding = encoding
    return this
  }

  override on(event: string, handler: (...args: unknown[]) => void): this {
    super.on(event, handler)
    if (STREAM_EVENTS.includes(event)) {
      this.scheduleBody()
    }
    return this
  }

  pause(): this {
    return this
  }

  resume(): this {
    return this
  }

  isPaused(): boolean {
    return false
  }

  destroy(): this {
    this.aborted = true
    return this
  }

  setTimeout(): this {
    return this
  }

  private scheduleBody(): void {
    if (this.scheduled || this.delivered) {
      return
    }
    this.scheduled = true
    this.timers.setTimeout(() => {
      this.scheduled = false
      this.pushBody()
    }, 0)
  }

  private pushBody(): void {
    if (this.delivered) {
      return
    }
    this.delivered = true
    const bytes = utf8Encode(this.body)
    if (bytes.byteLength > 0) {
      this.emit('data', this.encoding ? decodeWith(bytes, this.encoding) : asBuffer(bytes))
    }
    this.readable = false
    this.emit('end')
    this.emit('close')
  }
}

// ---------- 虚拟网络：ServerResponse ----------

type ServerResponseInit = {
  stdout: Sink
  timers: TimerRegistry
  exit: (code: number) => never
  request: IncomingMessage
}

/**
 * 响应对象：写出的内容先攒在内存里，end() 时一次性拼成 CGI 响应写 stdout，
 * 再让进程以 0 退出。没有 Content-Type 且正文非空时补 text/plain，
 * Content-Length 按 UTF-8 字节数补全（脚本显式设置过就尊重脚本）。
 */
class ServerResponse extends SandboxEmitter {
  statusCode = 200
  statusMessage: string | undefined = undefined
  headersSent = false
  finished = false
  writableEnded = false
  req: IncomingMessage
  socket: Record<string, unknown>
  private headers: HeaderMap = new Map()
  private bodyText = ''
  private bodyBytes = 0
  private exitCode = 0
  private init: ServerResponseInit

  constructor(init: ServerResponseInit) {
    super()
    this.init = init
    this.req = init.request
    this.socket = init.request.socket
  }

  setHeader(name: string, value: unknown): void {
    if (this.headersSent) {
      return
    }
    setHeaderValue(this.headers, String(name), value)
  }

  appendHeader(name: string, value: unknown): void {
    if (this.headersSent) {
      return
    }
    appendHeaderValue(this.headers, String(name), value)
  }

  getHeader(name: string): string | string[] | undefined {
    return getHeaderValue(this.headers, String(name))
  }

  getHeaders(): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {}
    for (const [key, entry] of this.headers) {
      result[key] = entry.values.length === 1 ? entry.values[0] : [...entry.values]
    }
    return result
  }

  getHeaderNames(): string[] {
    return [...this.headers.keys()]
  }

  hasHeader(name: string): boolean {
    return this.headers.has(String(name).toLowerCase())
  }

  removeHeader(name: string): void {
    if (this.headersSent) {
      return
    }
    this.headers.delete(String(name).toLowerCase())
  }

  writeHead(code: number, messageOrHeaders?: unknown, maybeHeaders?: unknown): this {
    this.statusCode = Number.isFinite(Number(code)) ? Number(code) : 200
    if (typeof messageOrHeaders === 'string') {
      this.statusMessage = messageOrHeaders
    }
    const source =
      typeof messageOrHeaders === 'object' && messageOrHeaders !== null
        ? messageOrHeaders
        : maybeHeaders
    this.applyHeaders(source)
    this.headersSent = true
    return this
  }

  write(chunk?: unknown, encoding?: unknown, callback?: unknown): boolean {
    if (this.finished) {
      return false
    }
    const cb =
      typeof encoding === 'function'
        ? (encoding as () => void)
        : typeof callback === 'function'
          ? (callback as () => void)
          : undefined
    this.appendChunk(chunk, typeof encoding === 'string' ? encoding : undefined)
    this.headersSent = true
    if (cb) {
      cb()
    }
    return true
  }

  end(chunk?: unknown, encoding?: unknown, callback?: unknown): this {
    const cb =
      typeof chunk === 'function'
        ? (chunk as () => void)
        : typeof encoding === 'function'
          ? (encoding as () => void)
          : typeof callback === 'function'
            ? (callback as () => void)
            : undefined
    if (this.finished) {
      if (cb) {
        cb()
      }
      return this
    }
    if (typeof chunk !== 'function' && chunk !== undefined && chunk !== null) {
      this.appendChunk(chunk, typeof encoding === 'string' ? encoding : undefined)
    }
    this.finished = true
    this.writableEnded = true
    this.headersSent = true
    this.flushResponse()
    this.emit('finish')
    this.emit('close')
    if (cb) {
      cb()
    }
    // 交给下一个定时器退出：handler 在 async 函数里调用 end() 也能正常收尾
    this.init.timers.setTimeout(() => this.init.exit(this.exitCode), 0)
    return this
  }

  flushHeaders(): void {
    this.headersSent = true
  }

  writeContinue(): void {
    // 虚拟网络没有 100-continue 交换
  }

  writeEarlyHints(): void {
    // 同上
  }

  setTimeout(): this {
    return this
  }

  destroy(): void {
    if (!this.finished) {
      this.end()
    }
  }

  /** 内部兜底：处理器抛异常时让进程以非零码退出，便于宿主判断失败 */
  markFailed(): void {
    this.exitCode = 1
  }

  private applyHeaders(source: unknown): void {
    if (Array.isArray(source)) {
      for (const item of source) {
        if (Array.isArray(item) && item.length >= 2) {
          setHeaderValue(this.headers, String(item[0]), item[1])
        }
      }
      return
    }
    if (source && typeof source === 'object') {
      for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
        setHeaderValue(this.headers, name, value)
      }
    }
  }

  private appendChunk(chunk: unknown, encoding?: string): void {
    if (chunk === undefined || chunk === null) {
      return
    }
    if (typeof chunk === 'string') {
      const kind = (encoding ?? 'utf8').toLowerCase()
      const bytes = encodeWith(chunk, kind)
      this.bodyText += kind === 'utf8' || kind === 'utf-8' ? chunk : utf8Decode(bytes)
      this.bodyBytes += bytes.byteLength
      return
    }
    if (chunk instanceof Uint8Array) {
      this.bodyText += utf8Decode(chunk)
      this.bodyBytes += chunk.byteLength
      return
    }
    const text = String(chunk)
    this.bodyText += text
    this.bodyBytes += utf8Encode(text).byteLength
  }

  private flushResponse(): void {
    const status = this.statusCode
    const message = this.statusMessage ?? HTTP_STATUS_CODES[status] ?? ''
    const headers = new Map(this.headers)
    if (!headers.has('content-length')) {
      setHeaderValue(headers, 'Content-Length', String(this.bodyBytes))
    }
    if (this.bodyBytes > 0 && !headers.has('content-type')) {
      setHeaderValue(headers, 'Content-Type', 'text/plain; charset=utf-8')
    }
    const lines = [message ? `Status: ${status} ${message}` : `Status: ${status}`]
    for (const entry of headers.values()) {
      for (const value of entry.values) {
        lines.push(`${entry.name}: ${value}`)
      }
    }
    this.init.stdout.write(`${lines.join('\r\n')}\r\n\r\n${this.bodyText}`)
  }
}

// ---------- 虚拟网络：http.Server ----------

type ListenOptions = {
  port: number | undefined
  host: string
  callback?: (...args: unknown[]) => void
}

/** listen(port[, host][, backlog][, cb]) 与 listen({ port, host }, cb) 两种写法都认 */
const parseListenArgs = (args: unknown[]): ListenOptions => {
  let port: number | undefined
  let host = ''
  let callback: ((...args: unknown[]) => void) | undefined
  const first = args[0]
  if (typeof first === 'object' && first !== null) {
    const options = first as { port?: unknown; host?: unknown; callback?: unknown }
    if (typeof options.port === 'number') {
      port = options.port
    }
    if (typeof options.host === 'string') {
      host = options.host
    }
    if (typeof options.callback === 'function') {
      callback = options.callback as (...args: unknown[]) => void
    }
  } else if (typeof first === 'number') {
    port = first
  }
  for (const arg of args.slice(1)) {
    if (typeof arg === 'string' && !host) {
      host = arg
    } else if (typeof arg === 'function') {
      callback = arg as (...args: unknown[]) => void
    }
  }
  return { port, host, callback }
}

/**
 * 虚拟 HTTP 服务。
 * - CGI 模式：listen 后立刻用环境变量里的请求调用一次 handler，res.end() 写响应并退出；
 * - 非 CGI 模式：没有真实端口可监听，写 stderr 提示后以 1 退出，绝不 hang。
 */
class HttpServer extends SandboxEmitter {
  listening = false
  private net: VirtualNetOptions
  private port: number | undefined = undefined
  private host = ''

  constructor(net: VirtualNetOptions, handler?: unknown) {
    super()
    this.net = net
    if (typeof handler === 'function') {
      this.on('request', handler as (...args: unknown[]) => void)
    }
  }

  listen(...args: unknown[]): this {
    const options = parseListenArgs(args)
    this.port = options.port
    this.host = options.host
    if (options.callback) {
      this.once('listening', options.callback)
    }
    this.listening = true
    this.emit('listening')
    this.startRequest()
    return this
  }

  close(callback?: unknown): this {
    this.listening = false
    if (typeof callback === 'function') {
      this.once('close', callback as (...args: unknown[]) => void)
    }
    this.emit('close')
    return this
  }

  address(): { address: string; family: string; port: number } {
    return { address: this.host || '127.0.0.1', family: 'IPv4', port: this.port ?? 0 }
  }

  getConnections(callback?: unknown): void {
    if (typeof callback === 'function') {
      ;(callback as (error: null, count: number) => void)(null, this.listening ? 1 : 0)
    }
  }

  ref(): this {
    return this
  }

  unref(): this {
    return this
  }

  setTimeout(): this {
    return this
  }

  private startRequest(): void {
    const env = this.net.env
    if (env.NANOVM_HTTP !== '1') {
      this.net.stderr.write(`${VIRTUAL_NETWORK_HINT}\n`)
      this.net.timers.setTimeout(() => this.net.exit(1), 0)
      return
    }
    const requestPort = (env.NANOVM_HTTP_PORT ?? '').trim()
    if (requestPort && this.port !== undefined && String(this.port) !== requestPort) {
      this.net.stderr.write(
        `NanoVM: 本次虚拟请求发往端口 ${requestPort}，与监听的 ${this.port} 不一致，` +
          `请用 vm serve ${this.port} 注册服务\n`
      )
      this.net.timers.setTimeout(() => this.net.exit(1), 0)
      return
    }
    // 等当前同步代码跑完（可能还有 on('request') 要注册）再投递请求
    this.net.timers.setTimeout(() => this.serveRequest(), 0)
  }

  private serveRequest(): void {
    const env = this.net.env
    const headers = parseCgiHeaders(env.NANOVM_HTTP_HEADERS, this.net.stderr)
    const host = env.NANOVM_HTTP_HOST || '127.0.0.1'
    const port = env.NANOVM_HTTP_PORT || String(this.port ?? 80)
    if (!headers.has('host')) {
      setHeaderValue(headers, 'Host', `${host}:${port}`)
    }
    if (!headers.has('connection')) {
      setHeaderValue(headers, 'Connection', 'close')
    }
    const body = this.net.stdin
    if (body.length > 0 && !headers.has('content-length')) {
      setHeaderValue(headers, 'Content-Length', String(utf8Encode(body).byteLength))
    }
    const request = new IncomingMessage({
      method: (env.NANOVM_HTTP_METHOD || 'GET').toUpperCase(),
      url: env.NANOVM_HTTP_URL || '/',
      headers,
      body,
      timers: this.net.timers,
    })
    const response = new ServerResponse({
      stdout: this.net.stdout,
      timers: this.net.timers,
      exit: this.net.exit,
      request,
    })
    this.keepRequestAlive(response)
    try {
      if (this.listenerCount('request') === 0) {
        throw new Error('虚拟 HTTP 请求已到达，但没有注册 request 处理器')
      }
      this.emit('request', request, response)
    } catch (error) {
      this.net.stderr.write(`${describeThrown(error)}\n`)
      // 已经 end() 过的响应也要把退出码改成 1（退出定时器在触发时才读 exitCode）
      response.markFailed()
      if (!response.finished) {
        response.statusCode = 500
        response.setHeader('Content-Type', 'text/plain; charset=utf-8')
        response.end(`NanoVM 虚拟 HTTP：处理器执行失败\n${describeThrown(error)}\n`)
      }
    }
  }

  /** handler 里可能有 await，用一串短定时器把沙箱撑到响应结束或全局超时 */
  private keepRequestAlive(response: ServerResponse): void {
    const poll = (): void => {
      this.net.timers.setTimeout(() => {
        if (!response.finished) {
          poll()
        }
      }, 8)
    }
    poll()
  }
}

// ---------- 虚拟网络：http.request / http.get ----------

type HttpRequestTarget = {
  protocol: string
  hostname: string
  port: string
  path: string
  method: string
  headers: Record<string, string>
  url: string
}

/** 这些主机名视为虚拟网络内部，不能走 fetch */
const VIRTUAL_HOST_NAMES = ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']

const normalizeHeaderRecord = (input: unknown): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (Array.isArray(input)) {
    for (const item of input) {
      if (Array.isArray(item) && item.length >= 2) {
        headers[String(item[0]).toLowerCase()] = String(item[1])
      }
    }
    return headers
  }
  if (input && typeof input === 'object') {
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      headers[name.toLowerCase()] = String(value)
    }
  }
  return headers
}

const normalizeRequestTarget = (
  input: unknown,
  fallbackMethod: string,
  defaultProtocol: string
): HttpRequestTarget => {
  if (typeof input === 'string') {
    let parsed: URL
    try {
      parsed = new URL(input)
    } catch {
      throw new Error(`NanoVM: http.request 只支持完整 URL（收到 '${input}'）`)
    }
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
      path: `${parsed.pathname || '/'}${parsed.search}`,
      method: fallbackMethod,
      headers: {},
      url: parsed.href,
    }
  }
  const options = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const rawProtocol = typeof options.protocol === 'string' ? options.protocol : defaultProtocol
  const protocol = rawProtocol.endsWith(':') ? rawProtocol : `${rawProtocol}:`
  const rawHost =
    typeof options.hostname === 'string'
      ? options.hostname
      : typeof options.host === 'string'
        ? options.host
        : 'localhost'
  const portMatch = /:(\d+)$/.exec(rawHost)
  let hostname = rawHost
  let hostPort = ''
  if (portMatch) {
    hostPort = portMatch[1]
    hostname = rawHost.slice(0, -portMatch[0].length)
  }
  const port =
    options.port !== undefined && options.port !== null && options.port !== ''
      ? String(options.port)
      : hostPort || (protocol === 'https:' ? '443' : '80')
  const pathname = typeof options.pathname === 'string' ? options.pathname : '/'
  const search = typeof options.search === 'string' ? options.search : ''
  const path =
    typeof options.path === 'string'
      ? options.path
      : `${pathname.startsWith('/') ? pathname : `/${pathname}`}${search}`
  return {
    protocol,
    hostname,
    port,
    path,
    method: typeof options.method === 'string' ? options.method.toUpperCase() : fallbackMethod,
    headers: normalizeHeaderRecord(options.headers),
    url: `${protocol}//${hostname}${port ? `:${port}` : ''}${path}`,
  }
}

/** fetch 拿到的响应转成 IncomingMessage 风格：statusCode / headers / on('data'|'end') */
class HttpClientResponse extends IncomingMessage {
  readonly statusCode: number
  readonly statusMessage: string

  constructor(init: IncomingMessageInit & { statusCode: number; statusMessage: string }) {
    super(init)
    this.statusCode = init.statusCode
    this.statusMessage = init.statusMessage
  }
}

const createClientResponse = async (
  response: Response,
  timers: TimerRegistry
): Promise<HttpClientResponse> => {
  const headers: HeaderMap = new Map()
  response.headers.forEach((value, name) => {
    appendHeaderValue(headers, name, value)
  })
  const body = await response.text()
  return new HttpClientResponse({
    headers,
    body,
    timers,
    method: '',
    url: '',
    statusCode: response.status,
    statusMessage: response.statusText,
  })
}

/** 最小的 ClientRequest：缓存 body，end() 时才真的发请求 */
class ClientRequest extends SandboxEmitter {
  method: string
  path: string
  host: string
  protocol: string
  aborted = false
  destroyed = false
  writableEnded = false
  private target: HttpRequestTarget
  private net: VirtualNetOptions
  private activity: ActivityTracker
  private callback?: (message: unknown) => void
  private chunks: Uint8Array[] = []
  private headers: Map<string, string>
  private sent = false

  constructor(
    target: HttpRequestTarget,
    net: VirtualNetOptions,
    activity: ActivityTracker,
    callback?: (message: unknown) => void
  ) {
    super()
    this.target = target
    this.net = net
    this.activity = activity
    this.callback = callback
    this.method = target.method
    this.path = target.path
    this.host = target.hostname
    this.protocol = target.protocol
    this.headers = new Map(Object.entries(target.headers))
  }

  setHeader(name: string, value: unknown): void {
    this.headers.set(String(name).toLowerCase(), String(value))
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(String(name).toLowerCase())
  }

  removeHeader(name: string): void {
    this.headers.delete(String(name).toLowerCase())
  }

  flushHeaders(): void {
    // 请求头在 end() 时统一发送
  }

  write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean {
    const textEncoding = typeof encoding === 'string' ? encoding : undefined
    if (typeof chunk === 'string') {
      this.chunks.push(encodeWith(chunk, textEncoding ?? 'utf8'))
    } else if (chunk instanceof Uint8Array) {
      this.chunks.push(new Uint8Array(chunk))
    } else if (chunk !== undefined && chunk !== null) {
      this.chunks.push(utf8Encode(String(chunk)))
    }
    const cb =
      typeof encoding === 'function'
        ? (encoding as () => void)
        : typeof callback === 'function'
          ? (callback as () => void)
          : undefined
    if (cb) {
      cb()
    }
    return true
  }

  end(chunk?: unknown, encoding?: unknown, callback?: unknown): this {
    if (this.sent) {
      return this
    }
    const cb =
      typeof chunk === 'function'
        ? (chunk as () => void)
        : typeof encoding === 'function'
          ? (encoding as () => void)
          : typeof callback === 'function'
            ? (callback as () => void)
            : undefined
    if (typeof chunk !== 'function' && chunk !== undefined && chunk !== null) {
      this.write(chunk, typeof encoding === 'string' ? encoding : undefined)
    }
    this.sent = true
    this.writableEnded = true
    this.start()
    if (cb) {
      cb()
    }
    return this
  }

  abort(): void {
    this.aborted = true
    this.emit('abort')
  }

  destroy(): void {
    this.aborted = true
    this.emit('close')
  }

  setTimeout(): this {
    return this
  }

  private start(): void {
    const hostname = this.target.hostname.toLowerCase()
    if (VIRTUAL_HOST_NAMES.includes(hostname)) {
      this.net.timers.setTimeout(() => {
        if (this.aborted) {
          return
        }
        const error = new Error('虚拟网络里的服务请用 curl 或虚拟 WebSocket 访问')
        // 没人监听 error 时按 Node 的习惯抛成未捕获异常，沙箱会打印并置退出码 1
        if (!this.emit('error', error)) {
          throw error
        }
      }, 0)
      return
    }
    const body = this.chunks.length > 0 ? BufferApi.concat(this.chunks) : undefined
    const init: RequestInit = {
      method: this.method,
      headers: Object.fromEntries(this.headers),
    }
    if (body) {
      // 复制到普通 Uint8Array：fetch 的 BufferSource 只接受 ArrayBuffer 支撑的视图
      init.body = new Uint8Array(body)
    }
    this.activity.begin()
    void fetch(this.target.url, init)
      .then(async (response) => {
        const message = await createClientResponse(response, this.net.timers)
        this.activity.done()
        if (this.aborted) {
          return
        }
        quarantineThrow(this.net.timers, () => {
          this.emit('response', message)
          if (this.callback) {
            this.callback(message)
          }
        })
      })
      .catch((error: unknown) => {
        this.activity.done()
        if (this.aborted) {
          return
        }
        const failure = error instanceof Error ? error : new Error(String(error))
        quarantineThrow(this.net.timers, () => {
          if (!this.emit('error', failure)) {
            this.net.stderr.write(`http: 请求失败：${describeThrown(failure)}\n`)
          }
        })
      })
  }
}

const createHttpModule = (
  net: VirtualNetOptions,
  defaultProtocol: string
): Record<string, unknown> => {
  const activity = createActivityTracker(net.timers)

  class Server extends HttpServer {
    constructor(handler?: unknown) {
      super(net, handler)
    }
  }

  const createServer = (optionsOrHandler?: unknown, maybeHandler?: unknown): Server => {
    const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler
    return new Server(handler)
  }

  const request = (input?: unknown, callback?: unknown): ClientRequest => {
    const target = normalizeRequestTarget(input, 'GET', defaultProtocol)
    const listener =
      typeof callback === 'function' ? (callback as (message: unknown) => void) : undefined
    return new ClientRequest(target, net, activity, listener)
  }

  const get = (input?: unknown, callback?: unknown): ClientRequest => {
    const clientRequest = request(input, callback)
    clientRequest.end()
    return clientRequest
  }

  return {
    STATUS_CODES: HTTP_STATUS_CODES,
    METHODS: HTTP_METHODS,
    createServer,
    request,
    get,
    Server,
    IncomingMessage,
    ServerResponse,
    ClientRequest,
    Agent: class Agent {
      destroy(): void {
        // 虚拟网络没有连接池，Agent 只是占位
      }
    },
    globalAgent: { destroy: () => undefined },
  }
}

// ---------- 虚拟网络：url / querystring ----------

type ParsedQuery = Record<string, string | string[]>

type LegacyUrl = {
  href: string
  protocol: string | null
  slashes: boolean | null
  auth: string | null
  host: string | null
  port: string | null
  hostname: string | null
  hash: string | null
  search: string | null
  pathname: string | null
  path: string | null
  query: string | ParsedQuery | null
}

const qsPrimitive = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return ''
}

const qsEscape = (text: string): string => encodeURIComponent(text)

const qsUnescape = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const qsStringify = (input: unknown, separator = '&', equals = '='): string => {
  if (!input || typeof input !== 'object') {
    return ''
  }
  const pairs: string[] = []
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const values = Array.isArray(raw) ? raw : [raw]
    for (const value of values) {
      pairs.push(`${qsEscape(key)}${equals}${qsEscape(qsPrimitive(value))}`)
    }
  }
  return pairs.join(separator)
}

const qsParse = (input: unknown, separator = '&', equals = '='): ParsedQuery => {
  const result: ParsedQuery = {}
  const text = String(input ?? '')
  if (!text) {
    return result
  }
  for (const pair of text.split(separator)) {
    if (!pair) {
      continue
    }
    const index = pair.indexOf(equals)
    const rawKey = index >= 0 ? pair.slice(0, index) : pair
    const rawValue = index >= 0 ? pair.slice(index + equals.length) : ''
    const key = qsUnescape(rawKey.replace(/\+/g, ' '))
    const value = qsUnescape(rawValue.replace(/\+/g, ' '))
    const existing = result[key]
    if (existing === undefined) {
      result[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      result[key] = [existing, value]
    }
  }
  return result
}

type AuthorityParts = {
  auth: string | null
  host: string | null
  hostname: string | null
  port: string | null
}

/** 拆 authority：user:pass@host:port；主机名小写，IPv6 的方括号保留在 host 里 */
const splitAuthority = (authority: string): AuthorityParts => {
  let rest = authority
  let auth: string | null = null
  const atIndex = rest.lastIndexOf('@')
  if (atIndex >= 0) {
    auth = qsUnescape(rest.slice(0, atIndex))
    rest = rest.slice(atIndex + 1)
  }
  rest = rest.toLowerCase()
  if (!rest) {
    return { auth, host: null, hostname: null, port: null }
  }
  if (rest.startsWith('[')) {
    const closeIndex = rest.indexOf(']')
    if (closeIndex >= 0) {
      const hostname = rest.slice(1, closeIndex)
      const tail = rest.slice(closeIndex + 1)
      const port = tail.startsWith(':') ? tail.slice(1) : null
      return {
        auth,
        hostname,
        port: port || null,
        host: port ? `[${hostname}]:${port}` : `[${hostname}]`,
      }
    }
  }
  const colonIndex = rest.lastIndexOf(':')
  if (colonIndex > 0 && /^\d*$/.test(rest.slice(colonIndex + 1))) {
    return {
      auth,
      hostname: rest.slice(0, colonIndex),
      port: rest.slice(colonIndex + 1) || null,
      host: rest,
    }
  }
  return { auth, host: rest, hostname: rest, port: null }
}

/**
 * url.parse 的兼容实现：相对路径按 legacy 语义返回（protocol 等为 null），
 * 绝对 URL 用原生 URL 校正大小写与转义。parseQuery 为 true（或对象里
 * parseQueryString 为 true）时 query 解析成对象。
 */
const parseLegacyUrl = (input: string, parseQuery?: unknown): LegacyUrl => {
  const wantQueryObject =
    parseQuery === true ||
    (typeof parseQuery === 'object' &&
      parseQuery !== null &&
      (parseQuery as { parseQueryString?: unknown }).parseQueryString === true)
  const text = typeof input === 'string' ? input : String(input ?? '')
  let rest = text
  let hash: string | null = null
  const hashIndex = rest.indexOf('#')
  if (hashIndex >= 0) {
    hash = rest.slice(hashIndex)
    rest = rest.slice(0, hashIndex)
  }
  let search: string | null = null
  const searchIndex = rest.indexOf('?')
  if (searchIndex >= 0) {
    search = rest.slice(searchIndex)
    rest = rest.slice(0, searchIndex)
  }
  let protocol: string | null = null
  let slashes: boolean | null = null
  let authority: AuthorityParts = { auth: null, host: null, hostname: null, port: null }
  const protocolMatch = /^([a-z][a-z0-9+.-]*):/i.exec(rest)
  if (protocolMatch) {
    protocol = `${protocolMatch[1].toLowerCase()}:`
    rest = rest.slice(protocolMatch[0].length)
  }
  if (protocol !== null && rest.startsWith('//')) {
    slashes = true
    rest = rest.slice(2)
    const slashIndex = rest.indexOf('/')
    const hostPart = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest
    rest = slashIndex >= 0 ? rest.slice(slashIndex) : ''
    authority = splitAuthority(hostPart)
  }
  const host = authority.host
  let pathname: string | null
  if (protocol !== null && host !== null) {
    pathname = rest === '' ? '/' : rest
  } else {
    pathname = rest === '' ? null : rest
  }
  let href: string
  if (protocol !== null && host !== null) {
    try {
      const parsed = new URL(text)
      // 用原生实现做转义与小写化，但保留 legacy 显式写出的协议默认端口
      const authPart = parsed.username
        ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
        : ''
      const portPart = authority.port ?? parsed.port
      const hostPart = `${parsed.hostname}${portPart ? `:${portPart}` : ''}`
      href = `${parsed.protocol}//${authPart}${hostPart}${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
      href = `${protocol}//${authority.auth ? `${authority.auth}@` : ''}${host}${pathname ?? ''}${search ?? ''}${hash ?? ''}`
    }
  } else {
    href = `${protocol ?? ''}${authority.auth ? `${authority.auth}@` : ''}${host ?? ''}${pathname ?? ''}${search ?? ''}${hash ?? ''}`
  }
  const path = pathname === null && search === null ? null : `${pathname ?? ''}${search ?? ''}`
  const query: string | ParsedQuery | null = wantQueryObject
    ? qsParse(search === null ? '' : search.slice(1))
    : search === null
      ? null
      : search.slice(1)
  return {
    href,
    protocol,
    slashes,
    auth: authority.auth,
    host,
    port: authority.port,
    hostname: authority.hostname,
    hash,
    search,
    pathname,
    path,
    query,
  }
}

const joinUrlPath = (basePath: string, targetPath: string): string => {
  const index = basePath.lastIndexOf('/')
  return index >= 0 ? `${basePath.slice(0, index + 1)}${targetPath}` : targetPath
}

/** 折叠 . 与 ..，保留是否以 / 开头 */
const normalizeUrlPath = (path: string): string => {
  const leading = path.startsWith('/')
  const segments: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      segments.pop()
      continue
    }
    segments.push(part)
  }
  const joined = segments.join('/')
  return leading ? `/${joined}` : joined
}

/** url.format 的兼容实现：字段优先，没有任何字段时才用 href（与 legacy 行为一致） */
const formatLegacyUrl = (input: unknown): string => {
  if (typeof input === 'string') {
    return input
  }
  if (!input || typeof input !== 'object') {
    throw new TypeError('The "urlObject" argument must be one of type object or string')
  }
  const obj = input as Record<string, unknown>
  const hasFields = [
    'protocol',
    'host',
    'hostname',
    'auth',
    'pathname',
    'search',
    'query',
    'hash',
    'port',
  ].some((key) => obj[key] !== undefined && obj[key] !== null && obj[key] !== '')
  if (!hasFields) {
    return typeof obj.href === 'string' ? obj.href : ''
  }
  const protocol =
    typeof obj.protocol === 'string'
      ? obj.protocol.endsWith(':')
        ? obj.protocol
        : `${obj.protocol}:`
      : ''
  const auth = typeof obj.auth === 'string' && obj.auth ? `${obj.auth}@` : ''
  let host = typeof obj.host === 'string' ? obj.host : ''
  if (!host && typeof obj.hostname === 'string') {
    const port = obj.port === undefined || obj.port === null ? '' : String(obj.port)
    host = port ? `${obj.hostname}:${port}` : obj.hostname
  }
  let pathname = typeof obj.pathname === 'string' ? obj.pathname : ''
  if (host && pathname && !pathname.startsWith('/')) {
    pathname = `/${pathname}`
  }
  let search = ''
  if (typeof obj.search === 'string') {
    search = obj.search
  } else if (obj.query && typeof obj.query === 'object') {
    search = `?${qsStringify(obj.query)}`
  }
  if (search && !search.startsWith('?')) {
    search = `?${search}`
  }
  let hash = typeof obj.hash === 'string' ? obj.hash : ''
  if (hash && !hash.startsWith('#')) {
    hash = `#${hash}`
  }
  const protocolSlashes = /^(https?|wss?|ftp|file|gopher):$/.test(protocol)
  const useSlashes = obj.slashes === true || (obj.slashes !== false && protocolSlashes)
  return `${protocol}${useSlashes && host ? '//' : ''}${auth}${host}${pathname}${search}${hash}`
}

/** url.resolve 的兼容实现：绝对 URL 交给原生 URL，相对基准则在路径层面合并 */
const resolveLegacyUrl = (from: string, to: string): string => {
  const baseText = typeof from === 'string' ? from : String(from ?? '')
  const targetText = typeof to === 'string' ? to : String(to ?? '')
  if (/^[a-z][a-z0-9+.-]*:/i.test(targetText)) {
    return targetText
  }
  const base = parseLegacyUrl(baseText)
  if (base.protocol !== null && base.host !== null) {
    try {
      return new URL(targetText, base.href).href
    } catch {
      // 落到下面的手写合并
    }
  }
  const target = parseLegacyUrl(targetText)
  let pathname: string
  if (target.pathname === null) {
    pathname = base.pathname ?? ''
  } else if (target.pathname.startsWith('/')) {
    pathname = target.pathname
  } else {
    pathname = joinUrlPath(base.pathname ?? '', target.pathname)
  }
  const search = target.search ?? (target.pathname === null ? (base.search ?? '') : '')
  const hash = target.hash ?? ''
  return `${normalizeUrlPath(pathname)}${search}${hash}`
}

const createQuerystringModule = (): Record<string, unknown> => ({
  stringify: qsStringify,
  parse: qsParse,
  escape: qsEscape,
  unescape: qsUnescape,
})

const createUrlModule = (): Record<string, unknown> => ({
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  parse: parseLegacyUrl,
  format: formatLegacyUrl,
  resolve: resolveLegacyUrl,
  resolveObject: (from: string, to: string) => parseLegacyUrl(resolveLegacyUrl(from, to)),
})

// ---------- 虚拟网络：ws（WebSocket 单消息模式） ----------

/**
 * 虚拟 WebSocket：
 * - 服务端（NANOVM_WS=1）：宿主一条消息跑一次脚本，connection 回调收到一个
 *   ws 对象，send() 写 CGI body，close() 结束进程；
 * - 客户端：包一层浏览器原生 WebSocket，事件用 on('open'|'message'|'close') 转发。
 */
const createWsModule = (net: VirtualNetOptions): Record<string, unknown> => {
  const activity = createActivityTracker(net.timers)

  /** 单消息模式下服务端那一侧的 ws：send() 直接写 stdout 的 CGI body */
  class VirtualWebSocket extends SandboxEmitter {
    readyState = 1
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    private headWritten = false
    private closed = false

    send(data: unknown, callback?: unknown): void {
      if (this.closed) {
        return
      }
      this.writeHead()
      net.stdout.write(typeof data === 'string' ? data : inspectValue(data))
      if (typeof callback === 'function') {
        ;(callback as (error?: Error) => void)()
      }
    }

    close(code?: number, reason?: unknown): void {
      if (this.closed) {
        return
      }
      this.writeHead()
      this.closed = true
      this.readyState = 3
      this.emit(
        'close',
        typeof code === 'number' ? code : 1000,
        typeof reason === 'string' ? reason : ''
      )
      net.timers.setTimeout(() => net.exit(0), 0)
    }

    terminate(): void {
      this.close(1006, 'terminated')
    }

    ping(): void {
      // 单消息模式没有心跳
    }

    pong(): void {
      // 同上
    }

    private writeHead(): void {
      if (this.headWritten) {
        return
      }
      this.headWritten = true
      net.stdout.write('Status: 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n')
    }
  }

  class WebSocketServer extends SandboxEmitter {
    clients = new Set<VirtualWebSocket>()
    private port: number | undefined = undefined

    constructor(options?: unknown) {
      super()
      const settings = (options && typeof options === 'object' ? options : {}) as Record<
        string,
        unknown
      >
      this.port = typeof settings.port === 'number' ? settings.port : undefined
      const noServer = settings.noServer === true
      if (net.env.NANOVM_WS !== '1') {
        net.stderr.write(`${VIRTUAL_NETWORK_HINT}\n`)
        net.timers.setTimeout(() => net.exit(1), 0)
        return
      }
      const requestPort = (net.env.NANOVM_HTTP_PORT ?? '').trim()
      if (
        !noServer &&
        requestPort &&
        this.port !== undefined &&
        String(this.port) !== requestPort
      ) {
        net.stderr.write(
          `NanoVM: 本次虚拟 WebSocket 请求发往端口 ${requestPort}，与监听的 ${this.port} 不一致，` +
            `请用 vm serve ${this.port} 注册服务\n`
        )
        net.timers.setTimeout(() => net.exit(1), 0)
        return
      }
      net.timers.setTimeout(() => this.openConnection(), 0)
    }

    address(): { address: string; family: string; port: number } {
      return { address: '127.0.0.1', family: 'IPv4', port: this.port ?? 0 }
    }

    close(callback?: unknown): void {
      for (const socket of [...this.clients]) {
        if (socket.readyState === 1) {
          socket.close()
        }
      }
      this.clients.clear()
      this.emit('close')
      if (typeof callback === 'function') {
        ;(callback as () => void)()
      }
    }

    private openConnection(): void {
      const socket = new VirtualWebSocket()
      this.clients.add(socket)
      const headers = parseCgiHeaders(net.env.NANOVM_HTTP_HEADERS, net.stderr)
      const requestHeaders: Record<string, string> = {}
      for (const entry of headers.values()) {
        requestHeaders[entry.name.toLowerCase()] = entry.values.join(', ')
      }
      this.emit('listening')
      if (this.listenerCount('connection') === 0) {
        net.stderr.write('NanoVM: 虚拟 WebSocket 请求已到达，但没有注册 connection 处理器\n')
        net.timers.setTimeout(() => net.exit(1), 0)
        return
      }
      this.emit('connection', socket, {
        url: net.env.NANOVM_HTTP_URL || '/',
        headers: requestHeaders,
      })
      const message = net.env.NANOVM_WS_MESSAGE ?? ''
      net.timers.setTimeout(() => {
        if (socket.readyState === 1) {
          socket.emit('message', message, false)
        }
      }, 0)
    }
  }

  /** 客户端 WebSocket：没有原生实现时把错误交给 on('error') */
  class SandboxWebSocket extends SandboxEmitter {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    readyState = 0
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: unknown) => void) | null = null
    onclose: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    private socket: WebSocket | null = null
    private tracked = false
    private reported = false

    constructor(url: string, protocols?: unknown) {
      super()
      const scope = globalThis as unknown as { WebSocket?: unknown }
      const Native = scope.WebSocket
      if (typeof Native !== 'function') {
        this.readyState = 3
        net.timers.setTimeout(() => {
          const error = new Error('NanoVM: 当前环境没有原生 WebSocket，客户端 WebSocket 不可用')
          if (!this.emit('error', error)) {
            net.stderr.write(`${describeThrown(error)}\n`)
          }
        }, 0)
        return
      }
      this.readyState = 0
      let socket: WebSocket
      try {
        const Ctor = Native as new (target: string, protocols?: string | string[]) => WebSocket
        socket =
          protocols === undefined ? new Ctor(url) : new Ctor(url, protocols as string | string[])
      } catch (error) {
        this.readyState = 3
        net.timers.setTimeout(() => {
          const failure = error instanceof Error ? error : new Error(String(error))
          if (!this.emit('error', failure)) {
            net.stderr.write(`${describeThrown(failure)}\n`)
          }
        }, 0)
        return
      }
      this.socket = socket
      activity.begin()
      this.tracked = true
      socket.binaryType = 'arraybuffer'
      socket.onopen = (event: Event) => {
        this.readyState = 1
        quarantineThrow(net.timers, () => {
          this.emit('open')
          if (this.onopen) {
            this.onopen(event)
          }
        })
      }
      socket.onmessage = (event: MessageEvent) => {
        quarantineThrow(net.timers, () => {
          this.emit('message', event.data, typeof event.data !== 'string')
          if (this.onmessage) {
            this.onmessage(event)
          }
        })
      }
      socket.onclose = (event: CloseEvent) => {
        this.readyState = 3
        this.release()
        quarantineThrow(net.timers, () => {
          this.emit('close', event.code, event.reason)
          if (this.onclose) {
            this.onclose(event)
          }
        })
      }
      socket.onerror = (event: Event) => {
        this.release()
        quarantineThrow(net.timers, () => {
          if (!this.emit('error', event) && !this.onerror) {
            net.stderr.write('NanoVM: WebSocket 客户端连接出错\n')
          }
          if (this.onerror) {
            this.onerror(event)
          }
        })
      }
    }

    send(data: unknown): void {
      if (!this.socket) {
        return
      }
      if (data instanceof Uint8Array) {
        // 复制成普通 Uint8Array：原生 WebSocket 的 BufferSource 只认 ArrayBuffer 支撑的视图
        this.socket.send(new Uint8Array(data))
      } else {
        this.socket.send(String(data))
      }
    }

    close(code?: number, reason?: string): void {
      this.socket?.close(code, reason)
    }

    private release(): void {
      if (!this.tracked || this.reported) {
        return
      }
      this.reported = true
      this.tracked = false
      activity.done()
    }
  }

  return Object.assign(SandboxWebSocket, {
    WebSocket: SandboxWebSocket,
    WebSocketServer,
    Server: WebSocketServer,
  }) as unknown as Record<string, unknown>
}

// ---------- 沙箱执行 ----------

/** 用户脚本拿到的参数名（顺序与调用处一致） */
const SANDBOX_ARGS = [
  'exports',
  'require',
  'module',
  '__filename',
  '__dirname',
  'process',
  'console',
  'Buffer',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'global',
] as const

const formatThrown = (error: unknown): string => {
  if (error instanceof Error) {
    const stack = error.stack ?? `${error.name}: ${error.message}`
    // 只保留用户脚本相关的几帧，避免把沙箱内部实现暴露给用户
    const lines = stack.split('\n')
    const head = lines[0] ?? `${error.name}: ${error.message}`
    const frames = lines
      .slice(1)
      .filter(
        (line) => line.includes('eval') || line.includes('Function') || line.includes('anonymous')
      )
      .slice(0, 4)
    return [head, ...frames].join('\n')
  }
  return `Uncaught ${inspectValue(error)}`
}

/**
 * 执行一段 Node 风格脚本，返回退出码与文件改动。
 * 这是 Worker 与主线程回落共用的实现。
 */
export const executeNode = async (options: SandboxOptions): Promise<SandboxOutcome> => {
  const fs = new SandboxFs(options.files)
  const stdout = createSink(options.onStdout)
  const stderr = createSink(options.onStderr)
  const state = {
    cwd: normalizePath(options.cwd || '/home/user'),
    env: { ...options.env },
    stdin: options.stdin ?? '',
  }
  let asyncExit: number | null = null
  let asyncFailed = false
  const timers = new TimerRegistry((error) => {
    if (error instanceof ExitSignal) {
      asyncExit = normalizeExitCode(error.code)
      timers.clearAll()
      return
    }
    asyncFailed = true
    stderr.write(`${formatThrown(error)}\n`)
    timers.clearAll()
  })
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  const shouldAbort = options.shouldAbort ?? (() => false)

  // `<eval>` / `<stdin>` 这种伪路径保持原样，别当成真实文件解析
  const rawScript = options.scriptPath || 'index.js'
  const scriptPath = rawScript.startsWith('<') ? rawScript : resolvePath(state.cwd, rawScript)
  // 工作目录与脚本目录在沙箱里必须存在，否则脚本一开始就写不了相对路径的文件
  for (const dir of [state.cwd, dirNameOf(scriptPath)]) {
    try {
      fs.mkdir(dir, true)
    } catch {
      // 已存在
    }
  }

  const pathModule = createPathModule(() => state.cwd)
  const fsModule = createFsModule({ fs, getCwd: () => state.cwd })

  const processApi: Record<string, unknown> = {
    argv: ['/usr/local/bin/node', scriptPath, ...options.argv],
    env: state.env,
    platform: NODE_PLATFORM,
    arch: 'wasm',
    version: `v${NODE_VERSION}`,
    versions: { node: NODE_VERSION, nanovm: '2.7.9' },
    pid: 1,
    exitCode: 0,
    title: 'node',
    cwd: () => state.cwd,
    chdir: (path: string) => {
      const next = resolvePath(state.cwd, path)
      if (!fs.hasDir(next)) {
        throw fsError('ENOENT', 'chdir', next)
      }
      state.cwd = next
    },
    exit: (code?: number) => {
      throw new ExitSignal(typeof code === 'number' ? code : Number(processApi.exitCode ?? 0))
    },
    abort: () => {
      throw new ExitSignal(130)
    },
    stdout: {
      write: (text: string): boolean => {
        stdout.write(String(text))
        return true
      },
      isTTY: false,
      columns: 80,
    },
    stderr: {
      write: (text: string): boolean => {
        stderr.write(String(text))
        return true
      },
      isTTY: false,
      columns: 80,
    },
    stdin: { isTTY: false, readable: false, on: () => processApi, read: () => null },
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      queueMicrotask(() => callback(...args))
    },
    hrtime: Object.assign(
      () => {
        const ms = performance.now()
        return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1_000_000)]
      },
      { bigint: () => BigInt(Math.round(performance.now() * 1_000_000)) }
    ),
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    uptime: () => Math.max(0, (Date.now() - (deadline - timeoutMs)) / 1000),
    on: () => processApi,
    once: () => processApi,
    off: () => processApi,
    emit: () => false,
    removeListener: () => processApi,
    removeAllListeners: () => processApi,
  }

  const consoleApi = (() => {
    const writes = (target: Sink, values: unknown[]) => target.write(`${formatArgs(values)}\n`)
    // 虚拟网络的 CGI 响应就是 stdout，日志必须让路，否则会污染 Status 与响应头
    const wireMode = state.env.NANOVM_HTTP === '1' || state.env.NANOVM_WS === '1'
    const logTarget = wireMode ? stderr : stdout
    const timeLabels = new Map<string, number>()
    return {
      log: (...values: unknown[]) => writes(logTarget, values),
      info: (...values: unknown[]) => writes(logTarget, values),
      debug: (...values: unknown[]) => writes(logTarget, values),
      dir: (value: unknown) => writes(logTarget, [inspectValue(value)]),
      table: (value: unknown) => writes(logTarget, [inspectValue(value)]),
      trace: (...values: unknown[]) => writes(stderr, ['Trace:', ...values]),
      warn: (...values: unknown[]) => writes(stderr, values),
      error: (...values: unknown[]) => writes(stderr, values),
      assert: (condition: unknown, ...values: unknown[]) => {
        if (!condition) {
          writes(stderr, ['Assertion failed', ...values])
        }
      },
      time: (label = 'default') => {
        timeLabels.set(label, performance.now())
      },
      timeEnd: (label = 'default') => {
        const started = timeLabels.get(label)
        timeLabels.delete(label)
        if (started !== undefined) {
          writes(logTarget, [`${label}: ${(performance.now() - started).toFixed(3)}ms`])
        }
      },
      group: () => undefined,
      groupEnd: () => undefined,
      count: () => undefined,
    }
  })()

  const moduleObject = {
    exports: {} as Record<string, unknown>,
    id: scriptPath,
    filename: scriptPath,
    loaded: false,
  }
  const moduleCache = new Map<string, unknown>()

  // 虚拟网络：http / https / ws 都靠 env + stdin + stdout 完成一次请求
  const virtualNet: VirtualNetOptions = {
    env: state.env,
    stdin: state.stdin,
    stdout,
    stderr,
    timers,
    exit: (code: number): never => {
      throw new ExitSignal(code)
    },
  }
  const httpModule = createHttpModule(virtualNet, 'http:')
  const httpsModule = createHttpModule(virtualNet, 'https:')
  const urlModule = createUrlModule()
  const querystringModule = createQuerystringModule()
  const wsModule = createWsModule(virtualNet)

  const nodeModules: Record<string, unknown> = {
    fs: fsModule,
    'fs/promises': fsModule,
    path: pathModule,
    'path/posix': pathModule,
    http: httpModule,
    https: httpsModule,
    url: urlModule,
    querystring: querystringModule,
    ws: wsModule,
    process: processApi,
    buffer: { Buffer: BufferApi },
    os: {
      EOL: '\n',
      platform: () => NODE_PLATFORM,
      type: () => 'NanoVM',
      arch: () => 'wasm',
      cpus: () => [{ model: 'NanoVM virtual CPU', speed: 1000 }],
      tmpdir: () => '/tmp',
      homedir: () => '/home/user',
      hostname: () => 'nanovm',
      release: () => '2.7.9',
    },
    util: {
      format: (...values: unknown[]): string => formatArgs(values),
      inspect: (value: unknown): string => inspectValue(value),
      isDeepStrictEqual: (left: unknown, right: unknown): boolean =>
        JSON.stringify(left) === JSON.stringify(right),
      TextEncoder,
      TextDecoder,
    },
    events: {
      EventEmitter: class EventEmitter {
        private handlers = new Map<string, ((...args: unknown[]) => void)[]>()

        on(event: string, handler: (...args: unknown[]) => void) {
          const list = this.handlers.get(event) ?? []
          list.push(handler)
          this.handlers.set(event, list)
          return this
        }

        once(event: string, handler: (...args: unknown[]) => void) {
          return this.on(event, handler)
        }

        off(event: string, handler: (...args: unknown[]) => void) {
          const list = (this.handlers.get(event) ?? []).filter((item) => item !== handler)
          this.handlers.set(event, list)
          return this
        }

        emit(event: string, ...args: unknown[]): boolean {
          const list = this.handlers.get(event) ?? []
          for (const handler of list) {
            handler(...args)
          }
          return list.length > 0
        }
      },
    },
  }

  const requireModule = (id: string): unknown => {
    const name = id.startsWith('node:') ? id.slice(5) : id
    if (moduleCache.has(name)) {
      return moduleCache.get(name)
    }
    const found = nodeModules[name]
    if (found === undefined) {
      const error = new Error(`Cannot find module '${id}'`) as Error & { code: string }
      error.code = 'MODULE_NOT_FOUND'
      throw error
    }
    moduleCache.set(name, found)
    return found
  }

  const globalObject = {
    process: processApi,
    console: consoleApi,
    Buffer: BufferApi,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    require: requireModule,
    __dirname: dirNameOf(scriptPath),
    __filename: scriptPath,
  }

  let code = 0
  let timedOut = false
  let aborted = false

  try {
    const factory = new Function(
      SANDBOX_ARGS.join(','),
      `${options.code}\n//# sourceURL=nanovm-node://${scriptPath}`
    ) as (...args: unknown[]) => unknown
    factory(
      moduleObject.exports,
      requireModule,
      moduleObject,
      scriptPath,
      dirNameOf(scriptPath),
      processApi,
      consoleApi,
      BufferApi,
      timers.setTimeout,
      timers.clearTimeout,
      timers.setInterval,
      timers.clearInterval,
      globalObject
    )
  } catch (error) {
    if (error instanceof ExitSignal) {
      code = normalizeExitCode(error.code)
    } else {
      stderr.write(`${formatThrown(error)}\n`)
      code = 1
    }
  }

  if (code === 0) {
    const idle = await timers.drain(deadline, shouldAbort)
    if (idle === 'timeout') {
      timedOut = true
      code = 124
      stderr.write(`node: 执行超时（超过 ${timeoutMs} 毫秒）\n`)
    } else if (idle === 'aborted') {
      aborted = true
      code = 130
      stderr.write('node: 已被中断\n')
    }
  }

  if (asyncExit !== null) {
    code = asyncExit
  } else if (asyncFailed && code === 0) {
    code = 1
  }

  timers.clearAll()
  stdout.flush()
  stderr.flush()

  const changed: SandboxFileMap = {}
  for (const path of fs.writtenPaths()) {
    const bytes = fs.peek(path)
    if (bytes) {
      changed[path] = bytes
    }
  }
  const removed = fs.deletedPaths().filter((path) => !(path in changed))

  return { code, files: changed, removed, timedOut, aborted }
}

// ---------- Worker 入口 ----------

type WorkerScope = {
  postMessage: (message: NodeSandboxMessage) => void
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void
}

/** 判断当前是不是 Worker 作用域；主线程与 Node 里都返回 null */
const workerScope = (): WorkerScope | null => {
  if (typeof window !== 'undefined') {
    return null
  }
  const scope = globalThis as unknown as Partial<WorkerScope>
  if (typeof scope.postMessage !== 'function' || typeof scope.addEventListener !== 'function') {
    return null
  }
  return scope as WorkerScope
}

const handleRequest = async (scope: WorkerScope, request: NodeSandboxRequest): Promise<void> => {
  try {
    const outcome = await executeNode({
      code: request.code,
      scriptPath: request.scriptPath,
      argv: request.argv,
      env: request.env,
      cwd: request.cwd,
      files: request.files,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
      onStdout: (text) => scope.postMessage({ type: 'stdout', text }),
      onStderr: (text) => scope.postMessage({ type: 'stderr', text }),
    })
    scope.postMessage({ type: 'done', ...outcome })
  } catch (error) {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

const activeScope = workerScope()
if (activeScope) {
  activeScope.addEventListener('message', (event) => {
    const request = event.data as NodeSandboxRequest | null
    if (!request || request.type !== 'run') {
      return
    }
    void handleRequest(activeScope, request)
  })
}
