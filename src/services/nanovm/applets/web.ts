import type { Applet, AppletContext, AppletResult } from '../types.js'
import { addService, findService, portOf, readServices, runVirtualWs } from '../net/virtual.js'
import { fail, ok, parseArgs } from './helpers.js'

/**
 * 虚拟网络相关的命令：`serve` 注册静态服务，`wscat` 当 WebSocket 客户端。
 *
 * 127.0.0.1 / localhost 上的地址一律走虚拟机自己的服务（`vm serve` 注册的 CGI），
 * 其它地址交给浏览器原生 WebSocket —— 浏览器只允许 ws/wss，并且 https 页面里
 * 不能连 ws，这两点错误会原样告诉用户。
 */

const serveUsage = 'serve [端口] [目录]（默认 8080 与当前目录）'

const serveApplet: Applet = {
  name: 'serve',
  summary: '把当前目录（或指定目录）注册成虚拟网络上的静态 HTTP 服务',
  summaryEn: 'Register a directory as a static HTTP service on the virtual network',
  usage: serveUsage,
  run: (ctx: AppletContext): AppletResult => {
    const args = ctx.argv.slice(1)
    if (args[0] === '-h' || args[0] === '--help') {
      return ok(`${serveUsage}\n`)
    }
    const portText = args[0] ?? '8080'
    const port = Number.parseInt(portText, 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return fail(`serve: 端口必须是 1-65535（收到 '${portText}'）\n`, 2)
    }
    const dir = args[1] ?? '.'
    const absolute = dir.startsWith('/') ? dir : `${ctx.cwd.replace(/\/$/, '')}/${dir}`
    if (!ctx.fs.exists(absolute) || !ctx.fs.isDirectory(absolute)) {
      return fail(`serve: ${dir}: No such directory\n`, 1)
    }
    addService(ctx.fs, { port, kind: 'static', command: dir, cwd: ctx.cwd })
    return ok(
      `静态服务已注册：http://127.0.0.1:${port}/\n` +
        `目录：${absolute}\n` +
        `用 curl 访问，例如 curl http://127.0.0.1:${port}/index.html；vm serve list 查看全部服务\n`
    )
  },
}

const wscatUsage = 'wscat [-m 消息] [--once] ws://host:port/path（127.0.0.1 走虚拟机里的服务）'

/** 浏览器原生 WebSocket：发一条、收一条（或等到关闭），10 秒连接 / 8 秒接收超时 */
const realWebSocket = async (
  url: string,
  message: string,
  once: boolean
): Promise<AppletResult> => {
  const socket = await new Promise<WebSocket | string>((resolve) => {
    let created: WebSocket
    try {
      created = new WebSocket(url)
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error))
      return
    }
    const timer = setTimeout(() => {
      try {
        created.close()
      } catch {
        // 关闭失败不影响结果
      }
      resolve('连接超时（10 秒）')
    }, 10_000)
    created.onopen = () => {
      clearTimeout(timer)
      resolve(created)
    }
    created.onerror = () => {
      clearTimeout(timer)
      resolve('连接失败（浏览器只允许 ws/wss，且 https 页面不能连 ws）')
    }
  })
  if (typeof socket === 'string') {
    return fail(`wscat: ${socket}\n`, 1)
  }
  const lines: string[] = []
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {
        // 忽略
      }
      resolve()
    }, 8_000)
    socket.onmessage = (event) => {
      const data: unknown = event.data
      lines.push(`< ${typeof data === 'string' ? data : '[二进制帧]'}`)
      if (once) {
        clearTimeout(timer)
        socket.close()
        resolve()
      }
    }
    socket.onclose = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.onerror = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  const stdout = [`> ${message}`, ...lines].join('\n')
  return { code: 0, stdout: `${stdout}\n` }
}

const wscatApplet: Applet = {
  name: 'wscat',
  summary: 'WebSocket 客户端：127.0.0.1 走虚拟机服务（单消息），其余走浏览器原生 WebSocket',
  summaryEn: 'WebSocket client: loopback hits VM services, other hosts use the browser WebSocket',
  usage: wscatUsage,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    const parsed = parseArgs(ctx.argv, {
      m: 'value',
      message: 'value',
      once: 'boolean',
    })
    if (parsed.error) {
      return fail(`wscat: ${parsed.error}\n`, 2)
    }
    const urlText = parsed.operands[0]
    if (!urlText) {
      return fail(`wscat: 缺少地址\n用法：${wscatUsage}\n`, 2)
    }
    let url: URL
    try {
      url = new URL(/^wss?:\/\//i.test(urlText) ? urlText : `ws://${urlText}`)
    } catch {
      return fail(`wscat: 无效地址 '${urlText}'\n`, 2)
    }
    const message = (parsed.flags.m ?? parsed.flags.message ?? 'hello') as string
    const once = parsed.flags.once === true
    const loopback = /^(127\.0\.0\.1|localhost)$/.test(url.hostname)
    if (loopback) {
      const port = portOf(url)
      const service = findService(ctx.fs, port)
      if (!service) {
        return fail(`wscat: 127.0.0.1:${port} 上没有注册服务，先 vm serve --ws ${port} "命令"\n`, 1)
      }
      if (service.kind === 'static') {
        return fail('wscat: 静态服务不支持 WebSocket，请用 vm serve --ws 注册脚本服务\n', 1)
      }
      const result = await runVirtualWs(
        ctx,
        {
          method: 'GET',
          url: url.href,
          target: `${url.pathname || '/'}${url.search}`,
          host: `127.0.0.1:${port}`,
          headers: {},
          body: '',
        },
        service,
        message
      )
      if (result.stderr !== '') {
        return {
          code: 1,
          stdout: `> ${message}\n`,
          stderr: `wscat: ${result.stderr}\n`,
        }
      }
      return { code: 0, stdout: `> ${message}\n< ${result.reply}` }
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return fail(`wscat: 只支持 ws:// 或 wss://（收到 ${url.protocol}//）\n`, 2)
    }
    return realWebSocket(url.href, message, once)
  },
}

/** 虚拟网络命令；顺序即 help 里的展示顺序 */
export const WEB_APPLETS: Applet[] = [serveApplet, wscatApplet]

/** 服务列表文本（`vm serve list` 用） */
export const servicesTable = (ctx: AppletContext): string => {
  const services = readServices(ctx.fs)
  if (services.length === 0) {
    return '还没有注册服务。用 vm serve <端口> <命令> 或 serve <端口> [目录] 注册。\n'
  }
  const lines = ['端口   类型     命令 / 目录']
  for (const service of services) {
    lines.push(`${String(service.port).padEnd(6)} ${service.kind.padEnd(8)} ${service.command}`)
  }
  return `${lines.join('\n')}\n`
}
