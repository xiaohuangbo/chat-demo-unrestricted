import type { JsonSchema } from '../api/types.js'
import { normalizeGenuiSpec, parseGenuiSpec } from './genui.js'
import { extractCustomBody, normalizeCustomInjection } from './customInjection.js'

/**
 * 浏览器 Agent 工具（移植自 DeepSeek-Agent 的 browser / widget 工具）。
 *
 * 只包含真正运行在浏览器里的能力：时间、定位、天气、通知、剪贴板、网页抓取、
 * 生成文件、打开链接、生成可视化组件。MCP 工具、子 Agent、工作区读写与分支操作
 * 属于服务端 / 桌面端能力，这里刻意不移植。
 *
 * 每个工具都可以在设置里单独开关：关闭的工具既不会出现在请求的 tools 里，
 * 也不会被执行，模型完全看不到它。
 */

/** 工具返回的产物：生成的文件或可视化组件，随回复一起保存并展示 */
export type ToolArtifact = {
  id: string
  name: string
  mime: string
  /** file 走下载 / 预览，widget 在沙箱 iframe 里渲染，genui 用白名单组件原生渲染 */
  kind: 'file' | 'widget' | 'genui'
  text: string
  size: number
  createdAt: number
}

export type ToolResult = {
  content: string
  isError?: boolean
  artifacts?: ToolArtifact[]
}

export type ToolContext = {
  signal: AbortSignal
  locale: string
  /** 执行过程中的进度文案，会显示在工具卡片上 */
  progress: (text: string) => void
  /** 需要用户确认的工具：返回是否允许执行 */
  requestApproval: (input: Record<string, unknown>) => Promise<boolean>
}

/** 工具风险级别：safe 只读，network 会发出网络请求，write 会写入本机或产生文件 */
export type ToolRisk = 'safe' | 'network' | 'write'

export type AgentTool = {
  id: string
  /** 列表里展示的中文名 */
  label: string
  labelEn: string
  /** 一句话说明，用于设置页 */
  summary: string
  summaryEn: string
  description: string
  inputSchema: JsonSchema
  risk: ToolRisk
  /** 执行前是否需要用户确认 */
  requiresApproval?: boolean
  /** 单个工具的执行上限；默认 60 秒。WebVM 首次启动可能更久，单独放宽。 */
  timeoutMs?: number
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

// ---------- 参数与结果辅助 ----------

export const str = (input: Record<string, unknown>, key: string, fallback = ''): string => {
  const value = input[key]
  return typeof value === 'string' ? value : fallback
}

export const num = (input: Record<string, unknown>, key: string): number | undefined => {
  const value = input[key]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

export const bool = (input: Record<string, unknown>, key: string): boolean => input[key] === true

export const ok = (content: string, extra?: Partial<ToolResult>): ToolResult => ({
  content,
  ...extra,
})

export const fail = (content: string): ToolResult => ({ content, isError: true })

/** 截断过长文本，避免工具结果吃掉上下文 */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n\n…（已截断，共 ${text.length} 字符）`

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

/**
 * 带超时的 fetch：AbortSignal.timeout 在旧 Safari 上没有，
 * 这里手动组合调用方的 signal，保证兼容与可取消。
 */
const fetchWithTimeout = async (
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
  init: RequestInit = {}
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

// ---------- 时间日期 ----------

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const timeTool: AgentTool = {
  id: 'get_datetime',
  label: '时间日期',
  labelEn: 'Date & time',
  summary: '获取当前日期与时间，可指定 IANA 时区。',
  summaryEn: 'Current date and time, optionally in an IANA time zone.',
  description:
    '获取当前日期与时间。可指定 IANA 时区（如 Asia/Shanghai），缺省使用浏览器本地时区。返回本地化日期、ISO 时间、星期与时区偏移。',
  inputSchema: objectSchema({
    timezone: {
      type: 'string',
      description: 'IANA 时区名，例如 Asia/Shanghai、America/New_York；省略则用本地时区',
    },
    locale: { type: 'string', description: 'BCP 47 语言标签，默认跟随界面语言' },
  }),
  risk: 'safe',
  run: async (input, context) => {
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const timezone = str(input, 'timezone') || localZone
    const locale = str(input, 'locale') || context.locale || 'zh-CN'
    const now = new Date()
    let formatted = ''
    try {
      // 提前格式化一次，非法时区 / 语言会抛 RangeError
      formatted = new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now)
    } catch {
      return fail(`无效的时区或语言：${timezone} / ${locale}`)
    }
    // 目标时区的真实偏移：用 longOffset 取 GMT+08:00 这类值
    let offset = '未知'
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'longOffset',
      }).formatToParts(now)
      offset = parts.find((part) => part.type === 'timeZoneName')?.value ?? offset
    } catch {
      offset = '未知'
    }
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour12: false,
    }).formatToParts(now)
    const weekday = parts.find((part) => part.type === 'weekday')?.value ?? ''
    const weekdayLocal = locale.startsWith('zh')
      ? WEEKDAYS_ZH[now.getDay()]
      : WEEKDAYS_EN[now.getDay()]
    return ok(
      [
        `当前时间：${formatted}`,
        `时区：${timezone}（${offset}）`,
        `ISO：${now.toISOString()}`,
        `本地时间戳：${now.getTime()}`,
        `周几：${weekday} / ${weekdayLocal}`,
      ].join('\n')
    )
  },
}

// ---------- 网络定位 ----------

type Coords = { latitude: number; longitude: number; accuracy: number }

const getCoordinates = (highAccuracy: boolean, signal: AbortSignal): Promise<Coords> =>
  new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('当前浏览器不支持定位'))
      return
    }
    const onAbort = () => reject(new Error('已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    navigator.geolocation.getCurrentPosition(
      (position) => {
        signal.removeEventListener('abort', onAbort)
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        })
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        const reasons: Record<number, string> = {
          1: '定位权限被拒绝，请在浏览器地址栏的权限设置中允许',
          2: '暂时无法获取位置，请检查系统定位服务',
          3: '定位超时，请重试',
        }
        reject(new Error(reasons[error.code] ?? error.message))
      },
      { enableHighAccuracy: highAccuracy, timeout: 12_000, maximumAge: 60_000 }
    )
  })

/** 逆地理编码：免费接口，失败时只返回坐标 */
const reverseGeocode = async (coords: Coords, signal: AbortSignal): Promise<string | null> => {
  try {
    const url =
      'https://api.bigdatacloud.net/data/reverse-geocode-client' +
      `?latitude=${coords.latitude}&longitude=${coords.longitude}&localityLanguage=zh`
    const response = await fetchWithTimeout(url, signal, 8_000)
    if (!response.ok) {
      return null
    }
    const data = (await response.json()) as {
      city?: string
      locality?: string
      principalSubdivision?: string
      countryName?: string
    }
    const name = [data.countryName, data.principalSubdivision, data.city || data.locality]
      .filter(Boolean)
      .join(' · ')
    return name || null
  } catch {
    return null
  }
}

const locationTool: AgentTool = {
  id: 'get_location',
  label: '网络定位',
  labelEn: 'Location',
  summary: '获取用户当前地理位置，浏览器会弹出定位授权。',
  summaryEn: 'Current geolocation; the browser asks for permission.',
  description:
    '获取用户当前地理位置。浏览器会弹出定位授权，返回经纬度、精度与逆地理得到的城市名。仅在用户明确需要位置时调用。',
  inputSchema: objectSchema({
    high_accuracy: { type: 'boolean', description: '是否要求高精度定位，默认 false' },
  }),
  risk: 'safe',
  run: async (input, context) => {
    try {
      const coords = await getCoordinates(bool(input, 'high_accuracy'), context.signal)
      context.progress('正在解析城市名…')
      const place = await reverseGeocode(coords, context.signal)
      return ok(
        [
          `纬度：${coords.latitude.toFixed(5)}`,
          `经度：${coords.longitude.toFixed(5)}`,
          `精度：约 ${Math.round(coords.accuracy)} 米`,
          place ? `位置：${place}` : '位置：未能解析城市名',
        ].join('\n')
      )
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  },
}

// ---------- 天气 ----------

const WEATHER_ZH: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '强毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴大冰雹',
}

const WEATHER_EN: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Light snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail',
}

const describeWeather = (code: number, locale: string): string => {
  const table = locale.startsWith('zh') ? WEATHER_ZH : WEATHER_EN
  return table[code] ?? (locale.startsWith('zh') ? `天气码 ${code}` : `Weather code ${code}`)
}

type GeocodeResult = {
  name: string
  latitude: number
  longitude: number
  country?: string
  admin1?: string
}

const geocode = async (
  name: string,
  locality: string,
  signal: AbortSignal
): Promise<GeocodeResult | null> => {
  const url =
    'https://geocoding-api.open-meteo.com/v1/search' +
    `?name=${encodeURIComponent(name)}&count=1&language=${locality}&format=json`
  const response = await fetchWithTimeout(url, signal, 10_000)
  if (!response.ok) {
    return null
  }
  const data = (await response.json()) as { results?: GeocodeResult[] }
  return data.results?.[0] ?? null
}

type ForecastResponse = {
  timezone?: string
  current?: {
    time?: string
    temperature_2m?: number
    relative_humidity_2m?: number
    apparent_temperature?: number
    weather_code?: number
    wind_speed_10m?: number
    precipitation?: number
  }
  daily?: {
    time?: string[]
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_probability_max?: number[]
    sunrise?: string[]
    sunset?: string[]
  }
}

const weatherTool: AgentTool = {
  id: 'get_weather',
  label: '天气查询',
  labelEn: 'Weather',
  summary: '按城市或经纬度查天气，Open-Meteo 无需 Key。',
  summaryEn: 'Weather by city or coordinates via Open-Meteo.',
  description:
    '查询城市天气（Open-Meteo，无需 API Key）。可传城市名，或直接传经纬度；都不传时尝试使用浏览器定位。返回当前天气与未来数日预报。',
  inputSchema: objectSchema({
    location: { type: 'string', description: '城市名，如「杭州」「Tokyo」' },
    latitude: { type: 'number', description: '纬度，与 longitude 同时提供时优先于城市名' },
    longitude: { type: 'number', description: '经度' },
    days: { type: 'number', description: '预报天数 1-7，默认 3' },
  }),
  risk: 'network',
  run: async (input, context) => {
    const zh = context.locale.startsWith('zh')
    let latitude = num(input, 'latitude')
    let longitude = num(input, 'longitude')
    let place = str(input, 'location')
    const days = Math.min(7, Math.max(1, Math.round(num(input, 'days') ?? 3)))

    if (latitude === undefined || longitude === undefined) {
      if (!place) {
        context.progress(zh ? '正在获取定位…' : 'Getting location…')
        try {
          const coords = await getCoordinates(false, context.signal)
          latitude = coords.latitude
          longitude = coords.longitude
          place =
            (await reverseGeocode(coords, context.signal)) ?? (zh ? '当前位置' : 'Current location')
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return fail(
            zh
              ? `未提供城市，且定位失败：${reason}。请传入 location 或经纬度。`
              : `No city given and geolocation failed: ${reason}. Pass location or coordinates.`
          )
        }
      } else {
        context.progress(zh ? `正在解析 ${place}…` : `Resolving ${place}…`)
        const found = await geocode(place, zh ? 'zh' : 'en', context.signal)
        if (!found) {
          return fail(
            zh
              ? `找不到城市「${place}」，请换一个更常见的名称，或直接提供经纬度。`
              : `City "${place}" not found; try a more common name or pass coordinates.`
          )
        }
        latitude = found.latitude
        longitude = found.longitude
        place = [found.name, found.admin1, found.country].filter(Boolean).join(' · ')
      }
    }

    context.progress(zh ? '正在获取天气…' : 'Fetching weather…')
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
      `&timezone=auto&forecast_days=${days}`
    let response: Response
    try {
      response = await fetchWithTimeout(url, context.signal, 15_000)
    } catch (error) {
      return fail(
        zh
          ? `天气服务请求失败：${error instanceof Error ? error.message : String(error)}`
          : `Weather request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok) {
      return fail(
        zh ? `天气服务返回 ${response.status}` : `Weather service returned ${response.status}`
      )
    }
    const data = (await response.json()) as ForecastResponse
    const current = data.current
    const lines: string[] = [
      `${zh ? '地点' : 'Location'}：${place ?? `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`}`,
      `${zh ? '时区' : 'Time zone'}：${data.timezone ?? (zh ? '未知' : 'unknown')}`,
    ]
    if (current) {
      lines.push(
        '',
        `${zh ? '当前' : 'Now'}：${describeWeather(current.weather_code ?? -1, context.locale)}，${current.temperature_2m ?? '?'}°C`,
        zh
          ? `体感 ${current.apparent_temperature ?? '?'}°C，湿度 ${current.relative_humidity_2m ?? '?'}%，风速 ${current.wind_speed_10m ?? '?'} km/h`
          : `Feels like ${current.apparent_temperature ?? '?'}°C, humidity ${current.relative_humidity_2m ?? '?'}%, wind ${current.wind_speed_10m ?? '?'} km/h`,
        zh
          ? `降水 ${current.precipitation ?? 0} mm，更新于 ${current.time ?? ''}`
          : `Precipitation ${current.precipitation ?? 0} mm, updated ${current.time ?? ''}`
      )
    }
    const daily = data.daily
    if (daily?.time?.length) {
      lines.push('', zh ? '预报：' : 'Forecast:')
      daily.time.forEach((date, index) => {
        lines.push(
          zh
            ? `- ${date}：${describeWeather(daily.weather_code?.[index] ?? -1, context.locale)}，${daily.temperature_2m_min?.[index] ?? '?'}~${daily.temperature_2m_max?.[index] ?? '?'}°C，降水概率 ${daily.precipitation_probability_max?.[index] ?? 0}%`
            : `- ${date}: ${describeWeather(daily.weather_code?.[index] ?? -1, context.locale)}, ${daily.temperature_2m_min?.[index] ?? '?'}~${daily.temperature_2m_max?.[index] ?? '?'}°C, ${daily.precipitation_probability_max?.[index] ?? 0}% chance of rain`
        )
      })
    }
    return ok(lines.join('\n'))
  },
}

// ---------- 通知 ----------

const notificationTool: AgentTool = {
  id: 'send_notification',
  label: '发送通知',
  labelEn: 'Notification',
  summary: '发送系统桌面通知，首次需要授权。',
  summaryEn: 'System notification; asks for permission the first time.',
  description:
    '发送系统桌面通知。首次使用需要用户授予通知权限；页面处于后台时最有用。返回是否成功送达。',
  inputSchema: objectSchema(
    {
      title: { type: 'string', description: '通知标题' },
      body: { type: 'string', description: '通知正文' },
      tag: { type: 'string', description: '可选去重标签，同 tag 的通知会替换' },
    },
    ['title']
  ),
  risk: 'safe',
  run: async (input) => {
    if (!('Notification' in window)) {
      return fail('当前浏览器不支持通知')
    }
    let permission = Notification.permission
    if (permission === 'default') {
      permission = await Notification.requestPermission()
    }
    if (permission !== 'granted') {
      return fail('通知权限未授予，请在浏览器站点设置中允许通知')
    }
    const title = str(input, 'title') || 'Agent 通知'
    const body = str(input, 'body')
    try {
      new Notification(title, { body, tag: str(input, 'tag') || undefined })
    } catch (error) {
      return fail(`发送通知失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return ok(`已发送通知「${title}」`)
  },
}

// ---------- 剪贴板 ----------

const clipboardReadTool: AgentTool = {
  id: 'read_clipboard',
  label: '读取剪贴板',
  labelEn: 'Read clipboard',
  summary: '读取剪贴板纯文本，执行前需要确认。',
  summaryEn: 'Read clipboard text; asks for confirmation.',
  description: '读取剪贴板中的纯文本。浏览器可能要求页面处于焦点状态并授予剪贴板权限。',
  inputSchema: objectSchema({}),
  risk: 'safe',
  requiresApproval: true,
  run: async () => {
    try {
      const text = await navigator.clipboard.readText()
      return ok(text ? clip(text, 8000) : '（剪贴板为空）')
    } catch (error) {
      return fail(
        `读取剪贴板失败：${error instanceof Error ? error.message : String(error)}。请确认页面在前台并已授予剪贴板权限。`
      )
    }
  },
}

const clipboardWriteTool: AgentTool = {
  id: 'write_clipboard',
  label: '写入剪贴板',
  labelEn: 'Write clipboard',
  summary: '把文本写入系统剪贴板。',
  summaryEn: 'Copy text to the system clipboard.',
  description: '把文本写入系统剪贴板。',
  inputSchema: objectSchema({ text: { type: 'string', description: '要复制的文本' } }, ['text']),
  risk: 'write',
  run: async (input) => {
    const text = str(input, 'text')
    try {
      await navigator.clipboard.writeText(text)
      return ok(`已复制 ${text.length} 个字符到剪贴板`)
    } catch (error) {
      return fail(`写入剪贴板失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

// ---------- 抓取网页 ----------

/** 从 HTML 中抽取标题与正文，优先 article/main，去掉脚本与样式 */
export const extractReadable = (html: string, url: string): { title: string; text: string } => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const node of doc.querySelectorAll(
    'script, style, noscript, svg, iframe, form, nav, footer, aside'
  )) {
    node.remove()
  }
  const title = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title
  const root = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body
  const text = (root?.textContent ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title: title?.trim() || url, text }
}

const fetchPageTool: AgentTool = {
  id: 'fetch_webpage',
  label: '抓取网页',
  labelEn: 'Fetch webpage',
  summary: '抓取网页正文并转纯文本；跨域站点可能失败。',
  summaryEn: 'Fetch a page and extract text; CORS may block some sites.',
  description:
    '抓取指定 URL 的网页正文并转为纯文本。优先通过浏览器扩展抓取（不受跨域限制）；未安装扩展时用页面 fetch，可能因目标站点 CORS 失败。',
  inputSchema: objectSchema(
    {
      url: { type: 'string', description: '完整 URL，需包含 http(s) 协议' },
      max_chars: { type: 'number', description: '正文最大字符数，默认 12000' },
    },
    ['url']
  ),
  risk: 'network',
  run: async (input, context) => {
    const url = str(input, 'url')
    const max = Math.min(60000, Math.max(1000, Math.round(num(input, 'max_chars') ?? 12000)))
    let parsed: URL
    try {
      parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return fail('只支持 http/https 链接')
      }
    } catch {
      return fail(`无效的 URL：${url}`)
    }
    context.progress(context.locale.startsWith('zh') ? '正在请求…' : 'Requesting…')
    try {
      const response = await fetchWithTimeout(parsed.href, context.signal, 20_000, {
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      })
      if (!response.ok) {
        return fail(`请求失败：HTTP ${response.status}`)
      }
      const type = response.headers.get('content-type') ?? ''
      const raw = await response.text()
      const { title, text } =
        type.includes('html') || raw.trimStart().startsWith('<')
          ? extractReadable(raw, parsed.href)
          : { title: parsed.href, text: raw }
      return ok([`标题：${title}`, `链接：${parsed.href}`, '', clip(text, max)].join('\n'))
    } catch (error) {
      return fail(
        `抓取失败：${error instanceof Error ? error.message : String(error)}。可能是目标站点未开放跨域（CORS），安装浏览器扩展后可由扩展代抓。`
      )
    }
  },
}

// ---------- 生成文件 / 组件 ----------

/** 单个产物的文本上限，避免把整页数据塞进 IndexedDB */
const MAX_ARTIFACT_CHARS = 400_000

const artifactMime = (name: string): string => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const table: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    html: 'text/html',
    htm: 'text/html',
    csv: 'text/csv',
    json: 'application/json',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    xml: 'application/xml',
    yml: 'text/yaml',
    yaml: 'text/yaml',
    js: 'text/javascript',
    ts: 'text/typescript',
    py: 'text/x-python',
    css: 'text/css',
  }
  return table[ext] ?? 'text/plain'
}

const artifactId = (): string =>
  `artifact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const createArtifact = (
  name: string,
  text: string,
  mime: string,
  kind: 'file' | 'widget' | 'genui'
): ToolArtifact => ({
  id: artifactId(),
  name,
  mime,
  kind,
  text,
  size: new TextEncoder().encode(text).length,
  createdAt: Date.now(),
})

const createFileTool: AgentTool = {
  id: 'create_file',
  label: '生成文件',
  labelEn: 'Create file',
  summary: '在对话里生成可预览、可下载的文件；执行前需要确认。',
  summaryEn: 'Generate a previewable, downloadable file; asks for confirmation.',
  description:
    '在对话中生成一个可预览、可下载的文件（Markdown、HTML、CSV、JSON、SVG、代码等）。适合把结果整理成报告、表格或网页。文件只保存在浏览器本地。',
  inputSchema: objectSchema(
    {
      name: { type: 'string', description: '文件名，需带扩展名，例如 report.md' },
      content: { type: 'string', description: '完整的文件文本内容' },
      mime: { type: 'string', description: '可选 MIME，缺省按扩展名推断' },
      description: { type: 'string', description: '一句话说明这个文件是什么' },
    },
    ['name', 'content']
  ),
  risk: 'write',
  requiresApproval: true,
  run: async (input) => {
    const name = str(input, 'name').trim() || 'output.txt'
    const content = str(input, 'content')
    if (!content) {
      return fail('content 不能为空')
    }
    if (content.length > MAX_ARTIFACT_CHARS) {
      return fail(`文件过大（超过 ${MAX_ARTIFACT_CHARS} 字符），请拆分或缩小内容`)
    }
    const mime = str(input, 'mime') || artifactMime(name)
    const artifact = createArtifact(name, content, mime, 'file')
    const note = str(input, 'description')
    return ok(
      `已生成文件「${artifact.name}」（${artifact.size} 字节）${note ? `：${note}` : ''}。文件已展示在对话中，用户可预览或下载。`,
      { artifacts: [artifact] }
    )
  },
}

const openUrlTool: AgentTool = {
  id: 'open_url',
  label: '打开链接',
  labelEn: 'Open link',
  summary: '在新标签页打开链接，可能被弹窗拦截。',
  summaryEn: 'Open a link in a new tab; may be blocked by popup rules.',
  description: '在新标签页打开链接，供用户查看。可能被浏览器的弹窗拦截策略阻止。',
  inputSchema: objectSchema({ url: { type: 'string', description: '要打开的完整 URL' } }, ['url']),
  risk: 'network',
  run: async (input) => {
    const url = str(input, 'url')
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return fail('只支持 http/https 链接')
      }
      const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer')
      return opened
        ? ok(`已在新标签页打开 ${parsed.href}`)
        : fail('浏览器拦截了新标签页，请允许本站弹窗')
    } catch {
      return fail(`无效的 URL：${url}`)
    }
  },
}

const MAX_WIDGET_CHARS = 160_000

const widgetTool: AgentTool = {
  id: 'show_widget',
  label: '生成可视化组件',
  labelEn: 'Visualization widget',
  summary: '在对话里渲染可交互的 HTML 组件（沙箱 iframe）。',
  summaryEn: 'Render an interactive HTML widget in a sandboxed iframe.',
  description:
    '在对话里直接渲染一个可交互的 HTML 组件，用户看到的是组件本身，不是代码。' +
    '适合：图表、流程与架构示意、对比卡片、可调参数的演示、小型交互应用。' +
    'HTML 需要自包含：样式写在 <style> 里，脚本写在 <script> 里，不引用本地文件；' +
    '不要使用 alert/confirm/prompt，不要在顶层写死 body 高度（内容会自动撑开）。' +
    '组件运行在沙箱 iframe 中，无法访问聊天页面数据。' +
    '当一张图或一个可操作组件比大段文字更清楚时，主动调用本工具。',
  inputSchema: objectSchema(
    {
      title: { type: 'string', description: '组件标题，显示在卡片顶部' },
      html: { type: 'string', description: '完整的 HTML 片段或文档，含内联样式与脚本' },
      note: { type: 'string', description: '一句话说明组件展示了什么' },
    },
    ['title', 'html']
  ),
  risk: 'safe',
  run: async (input) => {
    const title = str(input, 'title').trim() || '可视化组件'
    const html = str(input, 'html')
    if (!html.trim()) {
      return fail('html 不能为空')
    }
    if (html.length > MAX_WIDGET_CHARS) {
      return fail(`HTML 过长（${html.length} 字符），请压缩到 ${MAX_WIDGET_CHARS} 字符以内`)
    }
    const slug =
      title
        .replace(/[\\/:*?"<>|\s]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'widget'
    const artifact = createArtifact(`${slug}.widget.html`, html, 'text/html', 'widget')
    const note = str(input, 'note').trim()
    return ok(
      `已生成组件《${title}》，用户可以在对话中直接查看和操作。${note ? `\n组件内容：${note}` : ''}`,
      { artifacts: [artifact] }
    )
  },
}

const MAX_GENUI_SPEC_CHARS = 60_000

const genuiTool: AgentTool = {
  id: 'show_genui',
  label: '生成 GenUI 界面',
  labelEn: 'GenUI',
  summary: '用 JSON 声明界面：指标卡、表格、图表、进度与提示块。',
  summaryEn: 'Declare an interface in JSON: stats, tables, charts, progress and callouts.',
  description:
    '用一段 JSON 在对话里渲染原生界面（参考 dsh-genui 的声明式组件树）。\n' +
    '输入 spec 是 JSON 字符串，结构为 {"title":"可选标题","blocks":[...]}，支持的块：\n' +
    '- text/heading：{type:"text",text:"…"}；divider：分割线\n' +
    '- stat：{type:"stat",label:"收入",value:"¥128,430",delta:"+12.4%",hint:"可选"}\n' +
    '- progress：{type:"progress",label:"完成度",value:0.72}（0–1）\n' +
    '- table：{type:"table",columns:["列1","列2"],rows:[["a","1"],["b","2"]],caption:"可选"}（表头可点击排序）\n' +
    '- chart：{type:"chart",kind:"line"|"bar",labels:["周一","周二"],series:[{name:"订单",data:[3,5]}],caption:"可选"}\n' +
    '- list：{type:"list",items:["…"]}；keyValue：{type:"keyValue",items:[{key:"系统",value:"Linux"}]}\n' +
    '- callout：{type:"callout",tone:"info"|"success"|"warn"|"error",title:"可选",text:"…"}\n' +
    '- card：{type:"card",title:"可选",blocks:[…]}；grid：{type:"grid",columns:2,items:[…]}（最多嵌套 3 层）\n' +
    '适合：数据摘要、对比、进度、迷你仪表盘。纯文本能说清时不要调用；不要用它替代普通回答。',
  inputSchema: objectSchema(
    {
      title: { type: 'string', description: '界面标题，显示在卡片顶部' },
      spec: {
        type: 'string',
        description:
          'GenUI 的 JSON 字符串，例如 {"title":"本月概览","blocks":[{"type":"stat","label":"收入","value":"¥128,430"}]}',
      },
      note: { type: 'string', description: '可选：一句话说明这个界面展示了什么' },
    },
    ['spec']
  ),
  risk: 'safe',
  run: async (input) => {
    const raw = str(input, 'spec')
    if (raw.length > MAX_GENUI_SPEC_CHARS) {
      return fail(`spec 过长（${raw.length} 字符），请压缩到 ${MAX_GENUI_SPEC_CHARS} 字符以内`)
    }
    const parsed = parseGenuiSpec(raw)
    if ('error' in parsed) {
      return fail(parsed.error)
    }
    const title = str(input, 'title').trim() || parsed.spec.title || 'GenUI'
    const text = normalizeGenuiSpec(parsed.spec)
    const slug =
      title
        .replace(/[\\/:*?"<>|\s]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'genui'
    const artifact = createArtifact(`${slug}.genui.json`, text, 'application/json', 'genui')
    const note = str(input, 'note').trim()
    return ok(
      `已生成 GenUI 界面《${title}》，共 ${parsed.spec.blocks.length} 个块，用户可以直接查看、排序表格。${note ? `\n界面内容：${note}` : ''}`,
      { artifacts: [artifact] }
    )
  },
}

/**
 * 自定义提示词注入工具：设置页只给一个开关与一份配置面板，
 * 真正下发给模型的工具名、描述、参数都由配置生成（见 customInjection.ts），
 * 所以这里的 description 只是给设置页看的说明，请求里会整体替换。
 */
export const CUSTOM_INJECTION_TOOL_ID = 'custom_injection'

const customInjectionTool: AgentTool = {
  id: CUSTOM_INJECTION_TOOL_ID,
  label: '提示词注入工具',
  labelEn: 'Prompt injection tool',
  summary: '自定义一个工具，让模型把回答正文写进它的参数，收到后还原成普通正文。',
  summaryEn:
    'Define your own tool so the model puts its answer body into its argument; restore it as text on arrival.',
  description:
    '由「自定义提示词注入工具」配置生成：工具名、描述、参数名都是用户自己在设置里填的。' +
    '开启强制工具调用时，请求会带 tool_choice 指向这个工具，模型的正文因此全部落在参数里。',
  inputSchema: objectSchema({ body: { type: 'string', description: '回答正文' } }, ['body']),
  risk: 'safe',
  // 只在兜底路径执行（正常流程在 chat store 里还原成正文，不会走到这里）
  run: async (input) => {
    const body = extractCustomBody(input, normalizeCustomInjection(null))
    return ok(body.trim() === '' ? '（没有正文）' : body)
  },
}

/** 浏览器工具；顺序即设置页展示顺序 */
export const AGENT_TOOLS: AgentTool[] = [
  timeTool,
  locationTool,
  weatherTool,
  notificationTool,
  clipboardReadTool,
  clipboardWriteTool,
  fetchPageTool,
  createFileTool,
  openUrlTool,
  widgetTool,
  genuiTool,
  customInjectionTool,
]

export const AGENT_TOOL_IDS = AGENT_TOOLS.map((tool) => tool.id)

/**
 * 工具注册表 = 浏览器工具 + 虚拟工作区工具 + NanoVM Slim 工具。
 * 后两组由各自的设置模块注入，避免互相 import 造成循环依赖。
 */
export const allAgentTools = (): AgentTool[] => [
  ...AGENT_TOOLS,
  ...workspaceTools(),
  ...nanovmTools(),
  ...webvmTools(),
  ...unkernelTools(),
]

export const agentToolById = (id: string): AgentTool | undefined =>
  allAgentTools().find((tool) => tool.id === id)

/** 由 agentToolSettings 在初始化时注入，避免 tools.ts 依赖设置模块 */
let workspaceTools: () => AgentTool[] = () => []
let nanovmTools: () => AgentTool[] = () => []
let webvmTools: () => AgentTool[] = () => []
let unkernelTools: () => AgentTool[] = () => []

export const registerWorkspaceTools = (loader: () => AgentTool[]) => {
  workspaceTools = loader
}

/** 由 agentToolSettings 注入 NanoVM Slim 工具 */
export const registerNanovmTools = (loader: () => AgentTool[]) => {
  nanovmTools = loader
}

/** 由 agentToolSettings 注入 WebVM（CheerpX）工具 */
export const registerWebvmTools = (loader: () => AgentTool[]) => {
  webvmTools = loader
}

/** 由 agentToolSettings 注入 Unkernel Linux 工具 */
export const registerUnkernelTools = (loader: () => AgentTool[]) => {
  unkernelTools = loader
}

/** 该工具在本机是否可用（通知 / 剪贴板 / 定位依赖浏览器能力） */
export const agentToolSupported = (tool: AgentTool): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  if (tool.id === 'send_notification') {
    return 'Notification' in window
  }
  if (tool.id === 'get_location') {
    return 'geolocation' in navigator
  }
  if (tool.id === 'read_clipboard' || tool.id === 'write_clipboard') {
    return typeof navigator.clipboard !== 'undefined'
  }
  return true
}
