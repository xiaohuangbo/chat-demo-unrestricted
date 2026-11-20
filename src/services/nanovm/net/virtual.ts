import { resolvePath } from '../fs.js'
import type { AppletContext } from '../types.js'

/**
 * NanoVM 的虚拟网络。
 *
 * 浏览器里没有 socket，所以「HTTP 服务」用 CGI 模型实现：
 * `vm serve 3000 "node app.js"` 把一个端口登记到 `/etc/nanovm/services.json`；
 * `curl http://127.0.0.1:3000/api` 时把注册的命令当成 CGI 程序跑一次，请求走
 * 环境变量 + stdin，响应从 stdout 按 CGI 头解析。WebSocket 也走同一套：
 * `wscat ws://127.0.0.1:3000/chat` 以单消息模式（NANOVM_WS=1）跑一次命令。
 *
 * 好处是不需要常驻进程，适合这种「命令跑完就返回」的 shell；代价是没有长连接、
 * 每次请求都是冷启动——文档里写明了。
 */

/** 服务类型：CGI 脚本 / 静态目录 / WebSocket（单消息） */
export type ServiceKind = 'cgi' | 'static' | 'ws'

export type ServiceEntry = {
  port: number
  kind: ServiceKind
  /** cgi / ws：要执行的命令；static：目录路径（相对注册时的 cwd 解析） */
  command: string
  /** 注册时的工作目录 */
  cwd: string
}

/** 哪些主机名算「虚拟网络」 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'])

/** 服务注册表放在 /etc 下，随虚拟机镜像一起导出 */
const SERVICES_FILE = '/etc/nanovm/services.json'

/** 请求深度：服务里再 curl 自己会无限递归，超过这个层数直接报错 */
const MAX_DEPTH = 3

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  wasm: 'application/wasm',
  zip: 'application/zip',
  gz: 'application/gzip',
  pdf: 'application/pdf',
}

/** 一次虚拟请求 */
export type VirtualRequest = {
  method: string
  /** 客户端请求的完整 URL */
  url: string
  /** 路径 + 查询串，CGI 里用 NANOVM_HTTP_URL 传 */
  target: string
  host: string
  headers: Record<string, string>
  body: string
  /** WebSocket 单消息模式时客户端发来的文本 */
  wsMessage?: string
}

/** 虚拟网络返回的响应 */
export type VirtualResponse = {
  status: number
  statusText: string
  headers: Array<[string, string]>
  bytes: Uint8Array
  /** 服务自己写进 stderr 的内容（500 时给用户看） */
  stderr: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** URL 是否指向虚拟网络（127.0.0.1 / localhost 等） */
export const isVirtualUrl = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname)

/** 从 URL 里取端口，http 默认 80 */
export const portOf = (url: URL): number => {
  if (url.port) {
    return Number.parseInt(url.port, 10)
  }
  return url.protocol === 'https:' ? 443 : 80
}

/** 读取服务注册表；文件缺失或损坏时返回空表 */
export const readServices = (fs: AppletContext['fs']): ServiceEntry[] => {
  const text = fs.readText(SERVICES_FILE)
  if (text === null) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) {
      return []
    }
    const out: ServiceEntry[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue
      }
      const record = item as Record<string, unknown>
      const port = typeof record.port === 'number' ? record.port : Number(record.port)
      const kind = record.kind
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        continue
      }
      if (kind !== 'cgi' && kind !== 'static' && kind !== 'ws') {
        continue
      }
      out.push({
        port,
        kind,
        command: typeof record.command === 'string' ? record.command : '',
        cwd: typeof record.cwd === 'string' ? record.cwd : '/home/user',
      })
    }
    return out
  } catch {
    return []
  }
}

/** 写回注册表（按端口排序） */
export const writeServices = (fs: AppletContext['fs'], entries: ServiceEntry[]): void => {
  const sorted = [...entries].sort((left, right) => left.port - right.port)
  const dir = resolvePath('/', '/etc/nanovm')
  if (!fs.exists(dir)) {
    fs.mkdir(dir, true)
  }
  fs.writeText(SERVICES_FILE, `${JSON.stringify(sorted, null, 2)}\n`)
}

/** 按端口找服务 */
export const findService = (fs: AppletContext['fs'], port: number): ServiceEntry | undefined =>
  readServices(fs).find((entry) => entry.port === port)

/** 注册服务（同端口覆盖） */
export const addService = (fs: AppletContext['fs'], entry: ServiceEntry): ServiceEntry[] => {
  const existing = readServices(fs).filter((item) => item.port !== entry.port)
  const next = [...existing, entry]
  writeServices(fs, next)
  return next
}

/** 删除服务；返回是否真的删掉了 */
export const removeService = (fs: AppletContext['fs'], port: number): boolean => {
  const existing = readServices(fs)
  const next = existing.filter((item) => item.port !== port)
  if (next.length === existing.length) {
    return false
  }
  writeServices(fs, next)
  return true
}

/** CGI 响应的解析结果 */
type CgiParsed = {
  status: number
  statusText: string
  headers: Array<[string, string]>
  bytes: Uint8Array
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

const statusTextOf = (status: number): string => STATUS_TEXT[status] ?? 'Unknown'

/**
 * 解析 CGI 输出。
 * 约定：可选 `Status: 201 Created`，之后是 `Name: value` 头，空行后是 body。
 * 完全没有头块时整段当 body、状态 200（脚本只 print 一个字符串也能用）。
 */
const parseCgi = (stdout: string): CgiParsed => {
  const normalized = stdout.replace(/\r\n/g, '\n')
  const split = normalized.indexOf('\n\n')
  if (split < 0) {
    return {
      status: 200,
      statusText: statusTextOf(200),
      headers: [['content-type', 'text/plain; charset=utf-8']],
      bytes: encoder.encode(stdout),
    }
  }
  const head = normalized.slice(0, split)
  const body = normalized.slice(split + 2)
  let status = 200
  let statusText = ''
  const headers: Array<[string, string]> = []
  for (const line of head.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) {
      continue
    }
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name.toLowerCase() === 'status') {
      const match = /^(\d{3})\s*(.*)$/.exec(value)
      if (match) {
        status = Number.parseInt(match[1], 10)
        statusText = match[2].trim()
      }
      continue
    }
    headers.push([name.toLowerCase(), value])
  }
  return {
    status,
    statusText: statusText || statusTextOf(status),
    headers,
    bytes: encoder.encode(body),
  }
}

const contentLength = (bytes: Uint8Array): string => String(bytes.byteLength)

/** 统一异常响应，避免服务崩溃时给用户一个空响应 */
const failure = (status: number, message: string, stderr = ''): VirtualResponse => {
  const body = encoder.encode(`${message}\n`)
  return {
    status,
    statusText: statusTextOf(status),
    headers: [
      ['content-type', 'text/plain; charset=utf-8'],
      ['content-length', contentLength(body)],
    ],
    bytes: body,
    stderr,
  }
}

/** 请求头转小写键名的普通对象 */
export const normalizeHeaders = (headers: Array<[string, string]>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [name, value] of headers) {
    out[name.toLowerCase()] = value
  }
  return out
}

/** 执行一次 CGI / WS 请求 */
export const runVirtualRequest = async (
  ctx: AppletContext,
  request: VirtualRequest,
  entry: ServiceEntry
): Promise<VirtualResponse> => {
  const depth = Number.parseInt(ctx.env.NANOVM_VNET_DEPTH ?? '0', 10) || 0
  if (depth >= MAX_DEPTH) {
    return failure(508, 'NanoVM: 虚拟网络请求嵌套过深（服务里又请求自己？）')
  }
  const env: Record<string, string> = {
    ...ctx.env,
    NANOVM_HTTP: '1',
    NANOVM_HTTP_METHOD: request.method.toUpperCase(),
    NANOVM_HTTP_URL: request.target,
    NANOVM_HTTP_HOST: request.host,
    NANOVM_HTTP_PORT: String(entry.port),
    NANOVM_HTTP_HEADERS: JSON.stringify(normalizeHeaders(Object.entries(request.headers))),
    NANOVM_VNET_DEPTH: String(depth + 1),
  }
  if (request.wsMessage !== undefined) {
    env.NANOVM_WS = '1'
    env.NANOVM_WS_MESSAGE = request.wsMessage
  }
  let result: Awaited<ReturnType<AppletContext['shell']['run']>>
  try {
    result = await ctx.shell.run(entry.command, {
      cwd: entry.cwd,
      env,
      stdin: request.body,
      silent: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure(502, `NanoVM: 服务执行失败：${message}`, message)
  }
  if (result.aborted) {
    return failure(504, 'NanoVM: 服务被中断')
  }
  if (result.code !== 0 && result.stdout.trim() === '') {
    // 服务自己的 stderr 一并给出来：Python 的 traceback 是排查服务的最快线索
    const detail = result.stderr.trim()
    return failure(
      502,
      `NanoVM: 服务退出码 ${result.code}，没有输出${detail === '' ? '' : `\n${detail}`}`,
      detail
    )
  }
  const parsed = parseCgi(result.stdout)
  if (result.stderr.trim() !== '') {
    const hasLength = parsed.headers.some(([name]) => name === 'content-length')
    if (!hasLength) {
      parsed.headers.push(['content-length', contentLength(parsed.bytes)])
    }
  }
  return { ...parsed, stderr: result.stderr.trim() }
}

/** WebSocket 单消息：返回服务写回的文本 */
export const runVirtualWs = async (
  ctx: AppletContext,
  request: VirtualRequest,
  entry: ServiceEntry,
  message: string
): Promise<{ reply: string; stderr: string }> => {
  const response = await runVirtualRequest(ctx, { ...request, wsMessage: message }, entry)
  return { reply: decoder.decode(response.bytes), stderr: response.stderr }
}

/** 目录列表页：静态服务没有 index.html 时用 */
const directoryPage = (path: string, entries: { name: string; dir: boolean }[]): string => {
  const rows = entries
    .map((entry) => {
      const suffix = entry.dir ? '/' : ''
      return `<li><a href="${encodeURIComponent(entry.name)}${suffix}">${entry.name}${suffix}</a></li>`
    })
    .join('')
  return `<!doctype html><meta charset="utf-8"><title>Index of ${path}</title><h1>Index of ${path}</h1><ul>${rows}</ul>`
}

/** 静态文件服务：只允许目录内的路径 */
export const serveStatic = (
  fs: AppletContext['fs'],
  entry: ServiceEntry,
  request: VirtualRequest
): VirtualResponse => {
  const root = resolvePath(entry.cwd, entry.command)
  let target = request.target.split('?')[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    return failure(400, 'NanoVM: 路径编码不正确')
  }
  const segments = target.split('/').filter((part) => part !== '' && part !== '.')
  if (segments.includes('..')) {
    return failure(403, 'NanoVM: 静态服务不允许访问上级目录')
  }
  let full = root
  for (const segment of segments) {
    full = resolvePath(full, segment)
  }
  if (!full.startsWith(root)) {
    return failure(403, 'NanoVM: 静态服务不允许访问上级目录')
  }
  const stat = fs.stat(full)
  if (!stat) {
    return failure(404, `${request.method} ${request.target} 404 Not Found`)
  }
  if (stat.kind === 'dir') {
    const index = resolvePath(full, 'index.html')
    if (fs.exists(index)) {
      const bytes = fs.read(index) ?? new Uint8Array(0)
      return {
        status: 200,
        statusText: 'OK',
        headers: [
          ['content-type', CONTENT_TYPES.html],
          ['content-length', contentLength(bytes)],
        ],
        bytes,
        stderr: '',
      }
    }
    const listing = fs
      .readdir(full)
      .filter((item) => item.name !== '.' && item.name !== '..')
      .map((item) => ({ name: item.name, dir: item.kind === 'dir' }))
    const body = encoder.encode(directoryPage(target, listing))
    return {
      status: 200,
      statusText: 'OK',
      headers: [
        ['content-type', CONTENT_TYPES.html],
        ['content-length', contentLength(body)],
      ],
      bytes: body,
      stderr: '',
    }
  }
  const bytes = fs.read(full) ?? new Uint8Array(0)
  const suffix = full.slice(full.lastIndexOf('.') + 1).toLowerCase()
  return {
    status: 200,
    statusText: 'OK',
    headers: [
      ['content-type', CONTENT_TYPES[suffix] ?? 'application/octet-stream'],
      ['content-length', contentLength(bytes)],
    ],
    bytes,
    stderr: '',
  }
}

/** 一次虚拟请求的总入口：按服务类型分发 */
export const dispatchVirtual = async (
  ctx: AppletContext,
  url: URL,
  options: {
    method: string
    headers: Record<string, string>
    body: string
  }
): Promise<VirtualResponse> => {
  const port = portOf(url)
  const entry = findService(ctx.fs, port)
  if (!entry) {
    return failure(
      502,
      `NanoVM: 127.0.0.1:${port} 上没有注册服务。用 vm serve ${port} "命令" 或 vm serve --static ${port} 目录 注册`
    )
  }
  const request: VirtualRequest = {
    method: options.method,
    url: url.href,
    target: `${url.pathname || '/'}${url.search}`,
    host: `${url.hostname}:${port}`,
    headers: options.headers,
    body: options.body,
  }
  if (entry.kind === 'static') {
    return serveStatic(ctx.fs, entry, request)
  }
  return runVirtualRequest(ctx, request, entry)
}
