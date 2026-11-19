import type { Applet, AppletContext, AppletResult } from '../types.js'
import { dirName, resolvePath } from '../fs.js'
import { fetchNet, netStatus, NetError, normalizeUrl } from '../netProxy.js'
import { dispatchVirtual, isVirtualUrl } from '../net/virtual.js'
import { fail, interrupted, ok, parseArgs, type FlagSpec, type ParsedArgs } from './helpers.js'

/**
 * 网络命令（curl / wget / ping）。
 *
 * 全部走 `netProxy.ts` 的 fetchNet：APK 里自动走内置代理（不受 CORS 限制），
 * 浏览器里直连或走用户配置的代理。失败时按 CORS / 代理 / 超时 / 网络分别给
 * 中文说明，不会把错误页当成功返回。响应体默认写 stdout，二进制必须落文件。
 * `ping` 也不是 ICMP：浏览器没有原始套接字与 DNS，用 HTTPS 探测往返时间。
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const BINARY_HINT = '二进制数据无法写入文本终端'

/** 直连被 CORS 拦下时的统一说明 */
const CORS_HINT =
  'APK 里会自动走内置代理；浏览器里可在 设置 → NanoVM Slim → 联网代理 里配置代理后重试'

/** ping 的探测参数：默认 4 次、间隔 1 秒、单次 3 秒超时 */
const PING_COUNT = 4
const PING_INTERVAL_MS = 1000
const PING_TIMEOUT_MS = 3000
const PING_MAX_COUNT = 50

const wantsHelp = (argv: string[]): boolean =>
  argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = error.cause
    const detail =
      cause instanceof Error && cause.message !== error.message ? `（${cause.message}）` : ''
    return `${error.message}${detail}`
  }
  return String(error)
}

const flagOn = (flags: ParsedArgs['flags'], ...names: string[]): boolean =>
  names.some((name) => flags[name] === true)

const flagText = (flags: ParsedArgs['flags'], ...names: string[]): string | null => {
  for (const name of names) {
    const value = flags[name]
    if (typeof value === 'string') {
      return value
    }
  }
  return null
}

const decodeText = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

const hasNul = (bytes: Uint8Array): boolean => {
  const limit = Math.min(bytes.length, 8000)
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true
    }
  }
  return false
}

const withNewline = (text: string): string =>
  text === '' || text.endsWith('\n') ? text : `${text}\n`

const parseUrl = (input: string): URL | null => {
  try {
    return new URL(input)
  } catch {
    return null
  }
}

/** 解析 `K: V` 形式的请求头 */
const parseHeader = (text: string): [string, string] | null => {
  const index = text.indexOf(':')
  if (index <= 0) {
    return null
  }
  const name = text.slice(0, index).trim()
  const value = text.slice(index + 1).trim()
  return name === '' ? null : [name, value]
}

/** parseArgs 的 flags 只保留最后一个值，-H 可能重复，需要单独收集 */
const collectHeaders = (argv: string[]): string[] => {
  const headers: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      break
    }
    if (arg === '-H' || arg === '--header') {
      const value = argv[index + 1]
      if (value !== undefined) {
        headers.push(value)
      }
      index += 1
      continue
    }
    if (arg.startsWith('--header=')) {
      headers.push(arg.slice('--header='.length))
      continue
    }
    if (arg.startsWith('-H') && arg.length > 2) {
      headers.push(arg.slice(2))
    }
  }
  return headers
}

/** fetchNet 入参要的是普通对象，这里把 -H 的列表并成表；-d 默认按表单编码 */
const buildHeaders = (list: string[], data: string | null): Record<string, string> => {
  const headers: Record<string, string> = {}
  let hasContentType = false
  for (const item of list) {
    const pair = parseHeader(item)
    if (!pair) {
      continue
    }
    headers[pair[0]] = pair[1]
    if (pair[0].toLowerCase() === 'content-type') {
      hasContentType = true
    }
  }
  if (data !== null && !hasContentType) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  return headers
}

const remoteFileName = (target: URL): string => {
  const segment = target.pathname.split('/').filter(Boolean).at(-1) ?? ''
  if (segment === '') {
    return 'index.html'
  }
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

type NetResponse = Awaited<ReturnType<typeof fetchNet>>

/** 响应头：netProxy 统一给小写键名的 Record，逐行打印即可 */
const responseHeaders = (response: NetResponse): [string, string][] =>
  Object.entries(response.headers)

const headersText = (response: NetResponse): string => {
  const lines = [`HTTP ${response.status}`]
  for (const [name, value] of responseHeaders(response)) {
    lines.push(`${name}: ${value}`)
  }
  return `${lines.join('\n')}\n`
}

/** 响应体转文本；二进制返回 null，由调用方给出落文件提示 */
const responseText = (response: NetResponse): string | null => {
  const text = decodeText(response.bytes)
  if (text === null || hasNul(response.bytes)) {
    return null
  }
  return text
}

/** 把 NetError 翻译成各命令的中文提示与退出码 */
const netFailure = (command: string, error: unknown, maxTime: number | null): AppletResult => {
  if (error instanceof NetError) {
    if (error.kind === 'timeout') {
      const suffix = maxTime === null ? '' : `（--max-time ${maxTime} 秒）`
      return fail(`${command}: 请求超时${suffix}\n`, command === 'curl' ? 28 : 4)
    }
    if (error.kind === 'cors') {
      // hint 就是给用户看的完整说明（含设置路径），优先用它
      return fail(`${command}: ${error.hint ?? CORS_HINT}\n`, command === 'curl' ? 6 : 4)
    }
    if (error.kind === 'proxy') {
      return fail(`${command}: 代理请求失败：${error.message}\n`, command === 'curl' ? 7 : 4)
    }
    if (error.kind === 'badurl') {
      return fail(`${command}: ${error.message}（只支持 http/https）\n`, command === 'curl' ? 3 : 1)
    }
    return fail(`${command}: 请求失败：${error.message}\n`, command === 'curl' ? 6 : 4)
  }
  return fail(`${command}: 请求失败：${describeError(error)}\n`, command === 'curl' ? 6 : 4)
}

/** 写文件：自动补父目录，返回错误文案（成功为 null） */
const saveFile = (ctx: AppletContext, targetPath: string, bytes: Uint8Array): string | null => {
  try {
    ctx.fs.mkdir(dirName(targetPath), true)
    ctx.fs.write(targetPath, bytes)
    return null
  } catch (error) {
    return describeError(error)
  }
}

const writeOutValue = (name: string, response: NetResponse, url: string): string => {
  if (name === 'http_code') {
    return String(response.status)
  }
  if (name === 'url_effective') {
    return url
  }
  if (name === 'size_download') {
    return String(response.bytes.byteLength)
  }
  if (name === 'content_type') {
    return response.contentType
  }
  // redirect_url 等需要真实跳转后的地址，netProxy 的返回体没有，给空串
  return ''
}

/** `-w` 格式：支持 %{http_code} 这类变量、%% 与 \n */
const formatWriteOut = (format: string, response: NetResponse, url: string): string => {
  let text = ''
  let index = 0
  while (index < format.length) {
    const char = format[index]
    if (char === '\\' && format[index + 1] === 'n') {
      text += '\n'
      index += 2
      continue
    }
    if (char === '%' && format[index + 1] === '%') {
      text += '%'
      index += 2
      continue
    }
    if (char === '%' && format[index + 1] === '{') {
      const end = format.indexOf('}', index + 2)
      if (end > 0) {
        text += writeOutValue(format.slice(index + 2, end), response, url)
        index = end + 1
        continue
      }
    }
    text += char
    index += 1
  }
  return text
}

// ---------- 虚拟网络 ----------

/**
 * 把发往 127.0.0.1 / localhost 的请求交给虚拟机里的服务（`vm serve` 注册）。
 * 浏览器不允许直连本机端口，所以这一层既是「本地服务」，也是这类地址唯一的出路。
 */
const virtualNetResponse = async (
  ctx: AppletContext,
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string
): Promise<NetResponse> => {
  const response = await dispatchVirtual(ctx, url, { method, headers, body })
  const text = decoder.decode(response.bytes)
  const headerRecord: Record<string, string> = {}
  for (const [name, value] of response.headers) {
    headerRecord[name] = value
  }
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 400,
    contentType: headerRecord['content-type'] ?? 'text/plain',
    headers: headerRecord,
    text,
    bytes: response.bytes,
    route: 'virtual',
  }
}

// ---------- curl ----------

const curlUsage =
  "curl [-siIL] [-o FILE|-O] [-X METHOD] [-H 'K: V'] [-d DATA] [--max-time N] [-w FORMAT] URL"

const curlSpec: FlagSpec = {
  s: 'boolean',
  i: 'boolean',
  include: 'boolean',
  I: 'boolean',
  L: 'boolean',
  O: 'boolean',
  o: 'value',
  X: 'value',
  H: 'value',
  d: 'value',
  w: 'value',
  m: 'value',
  'max-time': 'value',
  silent: 'boolean',
  head: 'boolean',
  location: 'boolean',
  output: 'value',
  request: 'value',
  header: 'value',
  data: 'value',
  'write-out': 'value',
}

/**
 * curl：默认跟随重定向；响应体写 stdout，-o/-O 落文件；
 * -I 只看响应头；非 2xx 一律报错，不把错误页当成功返回。
 */
const curlApplet: Applet = {
  name: 'curl',
  summary: 'HTTP 请求：-o 存文件、-O 用 URL 末段命名、-I 只看响应头（APK 自动走内置代理）',
  summaryEn: 'HTTP requests with -o/-O/-I/-X/-H/-d; uses the native proxy on APK',
  usage: curlUsage,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${curlUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, curlSpec)
    if (parsed.error) {
      return fail(`curl: ${parsed.error}\n`, 2)
    }
    if (interrupted(ctx)) {
      return { code: 130, stderr: 'curl: interrupted\n' }
    }
    const operands = parsed.operands
    if (operands.length === 0) {
      return fail('curl: 缺少 URL\n', 2)
    }
    if (operands.length > 1) {
      return fail(`curl: 一次只能请求一个 URL（多余：${operands.slice(1).join(' ')}）\n`, 2)
    }
    // 没写协议时补 https://（bing.com → https://bing.com），否则请求发不出去
    const target = parseUrl(normalizeUrl(operands[0]))
    if (!target) {
      return fail(`curl: 无效的 URL '${operands[0]}'\n`, 3)
    }
    const silent = flagOn(parsed.flags, 's', 'silent')
    const headOnly = flagOn(parsed.flags, 'I', 'head')
    const includeHeaders = flagOn(parsed.flags, 'i', 'include')
    const remoteName = flagOn(parsed.flags, 'O')
    const output = flagText(parsed.flags, 'o', 'output')
    const data = flagText(parsed.flags, 'd', 'data')
    const writeOut = flagText(parsed.flags, 'w', 'write-out')
    const requestName = flagText(parsed.flags, 'X', 'request')
    const method = requestName ?? (headOnly ? 'HEAD' : data !== null ? 'POST' : 'GET')
    const maxTimeText = flagText(parsed.flags, 'm', 'max-time')
    let maxTime: number | null = null
    if (maxTimeText !== null) {
      maxTime = Number.parseFloat(maxTimeText)
      if (!Number.isFinite(maxTime) || maxTime <= 0) {
        return fail(`curl: --max-time 需要正数秒（收到 '${maxTimeText}'）\n`, 2)
      }
    }
    let response: NetResponse
    try {
      response = isVirtualUrl(target)
        ? await virtualNetResponse(
            ctx,
            target,
            method,
            buildHeaders(collectHeaders(ctx.argv), data),
            data ?? ''
          )
        : await fetchNet(target.href, {
            method,
            headers: buildHeaders(collectHeaders(ctx.argv), data),
            body: data ?? undefined,
            signal: ctx.signal,
            timeoutMs: maxTime === null ? undefined : maxTime * 1000,
          })
    } catch (error) {
      if (interrupted(ctx) || ctx.signal?.aborted === true) {
        return { code: 130, stderr: 'curl: 已中断\n' }
      }
      return netFailure('curl', error, maxTime)
    }
    const writeOutText = writeOut === null ? '' : formatWriteOut(writeOut, response, target.href)
    const headerBlock = headOnly || includeHeaders ? headersText(response) : ''
    if (!response.ok) {
      // -i 时连错误响应体一起打印，方便看服务端到底回了什么
      const bodyText = includeHeaders ? responseText(response) : null
      return {
        code: 22,
        stdout: `${headerBlock}${bodyText ? withNewline(bodyText) : ''}${writeOutText}`,
        stderr: `curl: HTTP ${response.status}\n`,
      }
    }
    const outputPath = output !== null ? output : remoteName ? remoteFileName(target) : null
    let stdout = ''
    if (headOnly) {
      if (outputPath !== null) {
        const targetPath = resolvePath(ctx.cwd, outputPath)
        const error = saveFile(ctx, targetPath, encoder.encode(headersText(response)))
        if (error) {
          return fail(`curl: ${outputPath}: ${error}\n`, 23)
        }
        if (!silent) {
          stdout += `curl: 已保存到 '${targetPath}'\n`
        }
      } else {
        stdout += headersText(response)
      }
      stdout += writeOutText
      return { code: 0, stdout }
    }
    if (outputPath !== null) {
      const targetPath = resolvePath(ctx.cwd, outputPath)
      const error = saveFile(ctx, targetPath, response.bytes)
      if (error) {
        return fail(`curl: ${outputPath}: ${error}\n`, 23)
      }
      if (!silent) {
        stdout += `curl: 已保存到 '${targetPath}'\n`
      }
      stdout += writeOutText
      return { code: 0, stdout }
    }
    const text = responseText(response)
    if (text === null) {
      return fail(
        `curl: 响应是${BINARY_HINT}（${response.bytes.byteLength} 字节），请用 -o FILE 落文件\n`
      )
    }
    stdout += headerBlock
    stdout += withNewline(text)
    stdout += writeOutText
    return { code: 0, stdout }
  },
}

// ---------- wget ----------

const wgetUsage = 'wget [-q] [-O FILE] [-P DIR] URL'

const wgetSpec: FlagSpec = {
  q: 'boolean',
  O: 'value',
  P: 'value',
  quiet: 'boolean',
  'no-verbose': 'boolean',
  'output-document': 'value',
  'directory-prefix': 'value',
}

/** wget：默认把响应体存成 URL 末段文件名，-q 静默，-P 指定目录 */
const wgetApplet: Applet = {
  name: 'wget',
  summary: '下载文件：默认存成 URL 末段名，-O 指定文件、-P 指定目录、-q 安静',
  summaryEn: 'Download a URL to a file with -O/-P/-q',
  usage: wgetUsage,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${wgetUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, wgetSpec)
    if (parsed.error) {
      return fail(`wget: ${parsed.error}\n`, 2)
    }
    if (interrupted(ctx)) {
      return { code: 130, stderr: 'wget: interrupted\n' }
    }
    const operands = parsed.operands
    if (operands.length === 0) {
      return fail('wget: 缺少 URL\n', 2)
    }
    if (operands.length > 1) {
      return fail(`wget: 一次只能下载一个 URL（多余：${operands.slice(1).join(' ')}）\n`, 2)
    }
    // 没写协议时补 https://，wget bing.com 才能真的发出去
    const target = parseUrl(normalizeUrl(operands[0]))
    if (!target) {
      return fail(`wget: 无效的 URL '${operands[0]}'\n`, 1)
    }
    const quiet = flagOn(parsed.flags, 'q', 'quiet', 'no-verbose')
    const outputDocument = flagText(parsed.flags, 'O', 'output-document')
    const prefix = flagText(parsed.flags, 'P', 'directory-prefix')
    if (outputDocument === '') {
      return fail('wget: -O 需要一个文件名\n', 2)
    }
    let response: NetResponse
    try {
      response = isVirtualUrl(target)
        ? await virtualNetResponse(ctx, target, 'GET', {}, '')
        : await fetchNet(target.href, { method: 'GET', signal: ctx.signal })
    } catch (error) {
      if (interrupted(ctx) || ctx.signal?.aborted === true) {
        return { code: 130, stderr: 'wget: 已中断\n' }
      }
      return netFailure('wget', error, null)
    }
    if (!response.ok) {
      return { code: 8, stderr: `wget: HTTP ${response.status}\n` }
    }
    if (outputDocument === '-') {
      const text = responseText(response)
      if (text === null) {
        return fail(
          `wget: 响应是${BINARY_HINT}（${response.bytes.byteLength} 字节），请用 -O FILE 落文件\n`
        )
      }
      return { code: 0, stdout: withNewline(text) }
    }
    const targetPath =
      outputDocument !== null
        ? resolvePath(ctx.cwd, outputDocument)
        : resolvePath(
            prefix === null ? ctx.cwd : resolvePath(ctx.cwd, prefix),
            remoteFileName(target)
          )
    const error = saveFile(ctx, targetPath, response.bytes)
    if (error) {
      return fail(`wget: '${targetPath}': ${error}\n`, 1)
    }
    return { code: 0, stdout: quiet ? '' : `saving to '${targetPath}'\n` }
  },
}

// ---------- ping ----------

const pingUsage = 'ping [-q] [-c N] [-W 超时秒] [-s 包大小忽略] host'

/** 说明行只在第一次调用时出现，避免每次 ping 都刷屏 */
let pingExplained = false

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const pingDisplayHost = (url: string): string => {
  const parsed = parseUrl(url)
  return parsed ? parsed.host : url
}

/** 去掉根路径的结尾斜杠，展示更接近 ping 的习惯 */
const pingDisplayUrl = (url: string): string => (url.endsWith('/') ? url.slice(0, -1) : url)

type PingProbe = { ok: true; ms: number } | { ok: false; status: number | null; error: unknown }

/**
 * 一次连通性探测：先 HEAD（省流量），HEAD 不成功再 GET。
 * 任何 HTTP 响应都说明主机可达，只有 4xx/5xx 才当成失败继续试 GET。
 */
const pingProbe = async (
  url: string,
  ctx: AppletContext,
  timeoutMs: number
): Promise<PingProbe> => {
  let lastStatus: number | null = null
  let lastError: unknown = null
  for (const method of ['HEAD', 'GET']) {
    const started = performance.now()
    try {
      const response = await fetchNet(url, { method, signal: ctx.signal, timeoutMs })
      const elapsed = performance.now() - started
      if (response.status >= 400) {
        lastStatus = response.status
        continue
      }
      return { ok: true, ms: elapsed }
    } catch (error) {
      lastError = error
    }
  }
  return { ok: false, status: lastStatus, error: lastError }
}

/** 单包失败原因：区分超时 / CORS / 代理 / 网络，避免只给一句「失败」 */
const pingFailureLine = (failure: { status: number | null; error: unknown }): string => {
  if (failure.error instanceof NetError) {
    if (failure.error.kind === 'timeout') {
      return 'ping: 请求超时'
    }
    if (failure.error.kind === 'cors') {
      return 'ping: 目标不允许跨域（CORS）'
    }
    if (failure.error.kind === 'proxy') {
      return `ping: 代理请求失败：${failure.error.message}`
    }
    if (failure.error.kind === 'badurl') {
      return `ping: ${failure.error.message}（只支持 http/https）`
    }
    return `ping: 无法解析主机（浏览器里没有 ICMP/DNS，走的是 HTTPS）：${failure.error.message}`
  }
  if (failure.status !== null) {
    return `ping: HTTP ${failure.status}`
  }
  return `ping: 无法解析主机（浏览器里没有 ICMP/DNS，走的是 HTTPS）：${describeError(failure.error)}`
}

/**
 * ping：浏览器里没有 ICMP，用 HTTPS 往返时间模拟。
 * 输出尽量贴近 busybox 的格式（PING 头、seq= 行、统计与 rtt min/avg/max）。
 */
const pingApplet: Applet = {
  name: 'ping',
  summary: '用 HTTPS 探测主机连通性（浏览器里没有 ICMP），输出往返时间与丢包率',
  summaryEn: 'Probe host reachability over HTTPS with RTT and packet loss',
  usage: pingUsage,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${pingUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, {
      c: 'value',
      W: 'value',
      s: 'value',
      q: 'boolean',
      quiet: 'boolean',
    })
    if (parsed.error) {
      return fail(`ping: ${parsed.error}\n`, 2)
    }
    if (parsed.operands.length === 0) {
      return fail('ping: 需要一个主机名\n', 2)
    }
    if (parsed.operands.length > 1) {
      return fail(`ping: 一次只能探测一个主机（多余：${parsed.operands.slice(1).join(' ')}）\n`, 2)
    }
    const host = parsed.operands[0]
    const url = normalizeUrl(host)
    if (!parseUrl(url)) {
      return fail(`ping: 无法解析主机 '${host}'\n`, 2)
    }
    let count = PING_COUNT
    const countText = flagText(parsed.flags, 'c')
    if (countText !== null) {
      const parsedCount = Number.parseInt(countText, 10)
      if (!Number.isFinite(parsedCount) || parsedCount < 1) {
        return fail('ping: 非法的次数（-c 需要正整数）\n', 2)
      }
      count = Math.min(parsedCount, PING_MAX_COUNT)
    }
    let probeTimeout = PING_TIMEOUT_MS
    const waitText = flagText(parsed.flags, 'W')
    if (waitText !== null) {
      const waitSeconds = Number.parseFloat(waitText)
      if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
        return fail('ping: 非法的超时时间（-W 需要正数秒）\n', 2)
      }
      probeTimeout = Math.min(waitSeconds * 1000, 60_000)
    }
    const quiet = flagOn(parsed.flags, 'q', 'quiet')
    const display = pingDisplayHost(url)
    const shownUrl = pingDisplayUrl(url)
    const lines: string[] = []
    const errors: string[] = []
    if (!pingExplained) {
      pingExplained = true
      if (!quiet) {
        errors.push('ping: NanoVM 用 HTTPS 探测连通性，不是 ICMP\n')
      }
    }
    if (!quiet) {
      lines.push(`PING ${display} (${shownUrl}): 56 data bytes\n`)
    }
    const times: number[] = []
    let sent = 0
    let received = 0
    for (let seq = 0; seq < count; seq += 1) {
      if (seq > 0) {
        await delay(PING_INTERVAL_MS)
      }
      if (interrupted(ctx)) {
        return {
          code: 130,
          stdout: lines.join(''),
          stderr: `${errors.join('')}ping: interrupted\n`,
        }
      }
      sent += 1
      // 单次探测不超过剩余的执行时间，避免拖过 engine 的超时
      const remaining = Math.max(200, ctx.deadline - Date.now())
      const result = await pingProbe(url, ctx, Math.min(probeTimeout, remaining))
      if (interrupted(ctx)) {
        return {
          code: 130,
          stdout: lines.join(''),
          stderr: `${errors.join('')}ping: interrupted\n`,
        }
      }
      if (result.ok) {
        received += 1
        times.push(result.ms)
        if (!quiet) {
          lines.push(`64 bytes from ${display}: seq=${seq} time=${result.ms.toFixed(1)} ms\n`)
        }
      } else {
        errors.push(`${pingFailureLine(result)}\n`)
      }
    }
    const lossPercent = sent === 0 ? 100 : Math.round(((sent - received) / sent) * 100)
    lines.push(`--- ${display} ping statistics ---\n`)
    lines.push(
      `${sent} packets transmitted, ${received} packets received, ${lossPercent}% packet loss\n`
    )
    if (times.length > 0) {
      const min = Math.min(...times)
      const max = Math.max(...times)
      const average = times.reduce((sum, value) => sum + value, 0) / times.length
      lines.push(`rtt min/avg/max = ${min.toFixed(1)}/${average.toFixed(1)}/${max.toFixed(1)} ms\n`)
    } else {
      // 一个包都没回来时给一条路由诊断，方便定位是 CORS 还是代理没配好
      const status = netStatus()
      if (status.detail !== '') {
        errors.push(`ping: 当前联网路由：${status.detail}\n`)
      }
    }
    return { code: received > 0 ? 0 : 1, stdout: lines.join(''), stderr: errors.join('') }
  },
}

/** 网络类命令 */
export const NET_APPLETS: Applet[] = [curlApplet, wgetApplet, pingApplet]
