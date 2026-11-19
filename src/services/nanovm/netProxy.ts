import { nanoVMConfig, type NetMode } from './config.js'

/**
 * NanoVM 的联网层。
 *
 * 浏览器里没有 ICMP，也拿不到任意站点的响应：目标不许跨域时 `fetch` 直接抛
 * TypeError。这里按环境分三条路：
 * - **native**：APK 的本地 HTTP 服务（127.0.0.1:18765）提供了 `/__nanovm/fetch`
 *   代理，用 Android 的 HttpURLConnection 发请求，页面同源访问，不受 CORS 限制；
 * - **direct**：普通浏览器直连，能通的有 CORS 头；
 * - **custom**：用户自己配的代理前缀（`{url}` 占位或直接拼编码后的 URL）。
 *
 * 配置在 设置 → NanoVM Slim → 联网代理，见 config.ts 的 `netMode` / `proxyUrl`。
 */

export type NetRoute = 'native' | 'direct' | 'custom' | 'virtual'

export type NetErrorKind = 'cors' | 'network' | 'timeout' | 'proxy' | 'badurl'

/** 联网失败：带上 kind 与一句人能看懂的提示，应用集据此给不同文案 */
export class NetError extends Error {
  readonly kind: NetErrorKind
  readonly hint?: string

  constructor(kind: NetErrorKind, message: string, hint?: string) {
    super(message)
    this.name = 'NetError'
    this.kind = kind
    this.hint = hint
  }
}

export type NetRequest = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export type NetResult = {
  status: number
  ok: boolean
  contentType: string
  /** 响应头（小写键名），`curl -I` 逐行打印用 */
  headers: Record<string, string>
  text: string
  bytes: Uint8Array
  /** 实际走的路线，UI 可以显示「APK 内置代理」之类 */
  route: NetRoute
}

/** 单个响应体上限，避免把几十 MB 塞进终端 */
const MAX_BODY = 8 * 1024 * 1024
const NATIVE_TIMEOUT_MS = 20_000

/** 没写协议时补 https://（`wget bing.com` 这种） */
export const normalizeUrl = (input: string): string => {
  const text = input.trim()
  if (!text) {
    return text
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return text
  }
  if (text.startsWith('//')) {
    return `https:${text}`
  }
  return `https://${text}`
}

/** 从 index.html 注入的 meta 里取原生代理 token（只有 APK 里有） */
const nativeToken = (): string | null => {
  if (typeof document === 'undefined') {
    return null
  }
  const meta = document.querySelector('meta[name="nanovm-proxy"]')
  const token = meta?.getAttribute('content')?.trim()
  return token ? token : null
}

/** 当前环境有没有 APK 内置代理 */
export const nativeProxyAvailable = (): boolean => nativeToken() !== null

/** 当前生效的路线，控制台用来展示 */
export const netStatus = (): { mode: NetMode; route: NetRoute | 'off'; detail: string } => {
  const config = nanoVMConfig()
  if (config.netMode === 'direct') {
    return { mode: config.netMode, route: 'direct', detail: '直连（受 CORS 限制）' }
  }
  if (config.netMode === 'custom') {
    return config.proxyUrl
      ? { mode: config.netMode, route: 'custom', detail: `自定义代理 ${config.proxyUrl}` }
      : { mode: config.netMode, route: 'off', detail: '还没填代理地址' }
  }
  if (nativeProxyAvailable()) {
    return { mode: config.netMode, route: 'native', detail: 'APK 内置代理（不受 CORS 限制）' }
  }
  return { mode: config.netMode, route: 'direct', detail: '直连（受 CORS 限制）' }
}

/** 启动时调用：把 meta token 读进内存并预热一次探测，失败不影响其他功能 */
export const initNetProxy = async (): Promise<void> => {
  if (!nativeProxyAvailable()) {
    return
  }
  try {
    await fetch(`/__nanovm/ping?token=${encodeURIComponent(nativeToken() ?? '')}`, {
      cache: 'no-store',
    })
  } catch {
    // 探测失败就当作不可用，后续直连
  }
}

const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

const readBody = async (response: Response): Promise<{ bytes: Uint8Array; text: string }> => {
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer.slice(0, MAX_BODY))
  return { bytes, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
}

/** 走 APK 内置代理 */
const fetchNative = async (url: string, options: NetRequest): Promise<NetResult> => {
  const token = nativeToken()
  if (!token) {
    throw new NetError('network', '内置代理不可用')
  }
  const method = (options.method ?? 'GET').toUpperCase()
  const contentType = options.headers?.['content-type'] ?? options.headers?.['Content-Type'] ?? ''
  const target =
    `/__nanovm/fetch?token=${encodeURIComponent(token)}` +
    `&url=${encodeURIComponent(url)}&method=${encodeURIComponent(method)}` +
    (contentType ? `&ctype=${encodeURIComponent(contentType)}` : '')
  const requestHeaders: Record<string, string> = { ...options.headers }
  const response = await withTimeout(
    (signal) =>
      fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...requestHeaders },
        body: options.body ?? '',
        signal,
        cache: 'no-store',
      }),
    options.timeoutMs ?? NATIVE_TIMEOUT_MS
  )
  if (response.status === 502) {
    const detail = await response.text().catch(() => '')
    throw new NetError('network', detail || '代理请求失败')
  }
  const { bytes, text } = await readBody(response)
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    // 本地服务把上游响应头以 x-nanovm-h-<name> 转发过来
    if (name.toLowerCase().startsWith('x-nanovm-h-')) {
      headers[name.slice('x-nanovm-h-'.length).toLowerCase()] = value
    }
  })
  const status =
    Number(response.headers.get('x-nanovm-status') ?? response.status) || response.status
  return {
    status,
    ok: status >= 200 && status < 400,
    contentType: response.headers.get('x-nanovm-type') ?? headers['content-type'] ?? '',
    headers,
    text,
    bytes,
    route: 'native',
  }
}

/** 直连：只有目标允许跨域才拿得到内容 */
const fetchDirect = async (url: string, options: NetRequest): Promise<NetResult> => {
  const response = await withTimeout(
    (signal) =>
      fetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        signal,
        redirect: 'follow',
        cache: 'no-store',
      }),
    options.timeoutMs ?? NATIVE_TIMEOUT_MS
  )
  const { bytes, text } = await readBody(response)
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })
  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type') ?? '',
    headers,
    text,
    bytes,
    route: 'direct',
  }
}

/** 自定义代理：`{url}` 占位或直接拼在末尾 */
const proxyTarget = (url: string, prefix: string): string => {
  const base = prefix.trim()
  if (!base) {
    return url
  }
  if (base.includes('{url}')) {
    return base.replace('{url}', url)
  }
  if (base.includes('{urlencoded}')) {
    return base.replace('{urlencoded}', encodeURIComponent(url))
  }
  return base + url
}

const fetchCustom = async (
  url: string,
  prefix: string,
  options: NetRequest
): Promise<NetResult> => {
  const result = await fetchDirect(proxyTarget(url, prefix), options)
  return { ...result, route: 'custom' }
}

const CORS_HINT =
  '目标站点不允许跨域（CORS）。APK 里会自动走内置代理；浏览器里可以在 设置 → NanoVM Slim → 联网代理 里填一个代理前缀后重试。'

const PROXY_HINT =
  '自定义代理请求失败：检查代理地址是否可用、是否允许跨域，以及是否支持 {url} 占位。'

/**
 * 统一联网入口：按配置与环境自动选路线。
 * 直连抛 TypeError（网络 / CORS）且有自定义代理时自动重试一次。
 */
export const fetchNet = async (input: string, options: NetRequest = {}): Promise<NetResult> => {
  const url = normalizeUrl(input)
  if (!/^https?:\/\//i.test(url)) {
    throw new NetError('badurl', `不支持的地址：${input}`)
  }
  const config = nanoVMConfig()
  const mode: NetMode = config.netMode

  if (mode === 'custom' && config.proxyUrl) {
    try {
      return await fetchCustom(url, config.proxyUrl, options)
    } catch (error) {
      throw new NetError(
        'proxy',
        error instanceof Error ? error.message : String(error),
        PROXY_HINT
      )
    }
  }

  if (mode !== 'direct' && nativeProxyAvailable()) {
    return fetchNative(url, options)
  }

  try {
    return await fetchDirect(url, options)
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    if (aborted) {
      throw new NetError('timeout', `请求超时：${url}`)
    }
    // 用户可能只填了代理没切模式：有代理就再试一次
    if (config.proxyUrl) {
      try {
        return await fetchCustom(url, config.proxyUrl, options)
      } catch {
        // 落到下面的原始错误
      }
    }
    throw new NetError('cors', error instanceof Error ? error.message : String(error), CORS_HINT)
  }
}
