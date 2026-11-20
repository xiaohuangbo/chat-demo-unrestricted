import { isLocalModel } from '../local/catalog.js'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type { MessageUsage } from '../api/types.js'
import type { AssistantMessage, Session } from './types.js'

/**
 * 会话统计与费用估算。
 *
 * - 用量直接从会话里的 `usage` 汇总：未缓存输入、缓存读取、缓存写入、输出都是服务端上报的准确值；
 * - 首 token 与模型用时靠每次生成结束时记录的计时（按消息 id 累积），历史导入的消息没有计时就不参与平均；
 * - 费用按官方定价页的单价估算：高峰时段为工作日的 9:00–12:00 与 14:00–18:00（北京时间），
 *   其余时段（含周末）按空闲价，空闲价是高峰价的一半。
 */

const TIMING_KEY = 'chat-demo:run-timings'
const VOICE_KEY = 'chat-demo:voice-usage'
const MAX_TIMING_ENTRIES = 600

/** 单条回复的累计计时：续写会让 runs 增加 */
export type RunTiming = { runs: number; modelMs: number; firstTokenMs: number | null }

const readJson = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}

const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 隐私模式下写不进去也不影响本次显示
  }
}

/** 计时表在内存里缓存一份，统计弹窗逐条读取时不至于反复 JSON.parse */
let timingCache: Record<string, RunTiming> | null = null

const readTimingMap = (): Record<string, RunTiming> => {
  timingCache ??= readJson<Record<string, RunTiming>>(TIMING_KEY) ?? {}
  return timingCache
}

export const readRunTiming = (messageId: string): RunTiming | null => {
  const timing = readTimingMap()[messageId]
  return timing && typeof timing.modelMs === 'number' ? timing : null
}

/** 一次生成结束：累加模型用时，首 token 取第一次观测到的值 */
export const noteRunTiming = (
  messageId: string,
  run: { modelMs: number; firstTokenMs: number | null }
) => {
  const all = { ...readTimingMap() }
  const previous = all[messageId]
  all[messageId] = {
    runs: (previous?.runs ?? 0) + 1,
    modelMs: (previous?.modelMs ?? 0) + Math.max(0, Math.round(run.modelMs)),
    firstTokenMs: previous?.firstTokenMs ?? run.firstTokenMs,
  }
  const entries = Object.entries(all)
  if (entries.length > MAX_TIMING_ENTRIES) {
    const kept = entries.slice(entries.length - MAX_TIMING_ENTRIES)
    timingCache = Object.fromEntries(kept)
    writeJson(TIMING_KEY, timingCache)
    return
  }
  timingCache = all
  writeJson(TIMING_KEY, all)
}

type VoiceUsage = { chars: number; seconds: number }

let voiceCache: Record<string, VoiceUsage> | null = null

const readVoiceMap = (): Record<string, VoiceUsage> => {
  voiceCache ??= readJson<Record<string, VoiceUsage>>(VOICE_KEY) ?? {}
  return voiceCache
}

/** 全部会话的语音用量合计：统计页展示 TTS 字符与 ASR 秒数 */
export const totalVoiceUsage = (): VoiceUsage => {
  let chars = 0
  let seconds = 0
  for (const entry of Object.values(readVoiceMap())) {
    chars += entry.chars
    seconds += entry.seconds
  }
  return { chars, seconds }
}

export const readVoiceUsage = (sessionId: string | null): VoiceUsage => {
  if (!sessionId) {
    return { chars: 0, seconds: 0 }
  }
  const entry = readVoiceMap()[sessionId]
  return { chars: entry?.chars ?? 0, seconds: entry?.seconds ?? 0 }
}

const noteVoice = (sessionId: string | null, patch: Partial<VoiceUsage>) => {
  if (!sessionId) {
    return
  }
  const previous = readVoiceMap()[sessionId] ?? { chars: 0, seconds: 0 }
  voiceCache = {
    ...readVoiceMap(),
    [sessionId]: {
      chars: previous.chars + (patch.chars ?? 0),
      seconds: previous.seconds + (patch.seconds ?? 0),
    },
  }
  writeJson(VOICE_KEY, voiceCache)
}

export const noteTtsChars = (sessionId: string | null, chars: number) => {
  if (chars > 0) {
    noteVoice(sessionId, { chars })
  }
}

export const noteAsrSeconds = (sessionId: string | null, seconds: number) => {
  if (seconds > 0) {
    noteVoice(sessionId, { seconds })
  }
}

/** 会话累计用量与质量指标 */
export type SessionTotals = {
  rounds: number
  steps: number
  outputTokens: number
  inputUncached: number
  cacheRead: number
  cacheWrite: number
  cacheRate: number | null
  outputSpeed: number
  firstTokenAvg: number | null
  modelTime: number
  searchCount: number
  fetchCount: number
  parsedFiles: number
  parsedPages: number
}

const LAYOUT_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

const getExt = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 文档解析按页计费，客户端拿不到页数，按 100 KB 一页估算并至少算一页 */
export const estimatePages = (sizeBytes: number): number =>
  Math.max(1, Math.round(sizeBytes / 100_000))

export const aggregateSession = (session: Session | null): SessionTotals => {
  const totals: SessionTotals = {
    rounds: 0,
    steps: 0,
    outputTokens: 0,
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheRate: null,
    outputSpeed: 0,
    firstTokenAvg: null,
    modelTime: 0,
    searchCount: 0,
    fetchCount: 0,
    parsedFiles: 0,
    parsedPages: 0,
  }
  if (!session) {
    return totals
  }
  const firstTokens: number[] = []
  for (const message of session.messages) {
    if (message.role === 'user') {
      totals.rounds += 1
      for (const file of message.files) {
        if (LAYOUT_EXTS.has(getExt(file.name))) {
          totals.parsedFiles += 1
          totals.parsedPages += estimatePages(file.size)
        }
      }
      continue
    }
    if (message.role !== 'assistant') {
      continue
    }
    totals.steps += 1
    const usage = message.usage
    if (usage) {
      totals.inputUncached += usage.input_tokens ?? 0
      totals.cacheRead += usage.cache_read_input_tokens ?? 0
      totals.cacheWrite += usage.cache_creation_input_tokens ?? 0
      totals.outputTokens += usage.output_tokens ?? 0
      totals.searchCount +=
        usage.server_tool_use?.web_search_requests ??
        message.blocks.filter(
          (block) => block.type === 'server_tool_use' && block.name === 'deepseek_web_search'
        ).length
    }
    for (const block of message.blocks) {
      if (block.type !== 'server_tool_use') {
        continue
      }
      totals.steps += 1
      if (block.name === 'deepseek_read_url') {
        totals.fetchCount += 1
      }
    }
    const timing = readRunTiming(message.id)
    if (timing) {
      totals.modelTime += timing.modelMs
      if (timing.firstTokenMs !== null) {
        firstTokens.push(timing.firstTokenMs)
      }
    }
  }
  const totalInput = totals.inputUncached + totals.cacheRead + totals.cacheWrite
  totals.cacheRate = totalInput > 0 ? totals.cacheRead / totalInput : null
  totals.outputSpeed = totals.modelTime > 0 ? totals.outputTokens / (totals.modelTime / 1000) : 0
  totals.firstTokenAvg =
    firstTokens.length > 0
      ? firstTokens.reduce((sum, value) => sum + value, 0) / firstTokens.length
      : null
  return totals
}

/** 官方单价：元 / 百万 tokens，空闲时段；高峰时段按 2 倍 */
const MODEL_PRICE: Record<string, { cacheHit: number; cacheMiss: number; output: number }> = {
  'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
}

/** 联网搜索与抓取：5 元 / 1000 次 */
const SEARCH_PER_CALL = 5 / 1000
/** 文件解析：1.5 元 / 1000 页 */
const PARSE_PER_PAGE = 1.5 / 1000
/** 语音合成：3 元 / 10000 字符（限时 5 折） */
const TTS_PER_CHAR = 3 / 10000
/** 语音识别：0.78 元 / 小时（限时 5 折） */
const ASR_PER_SECOND = 0.78 / 3600

/** 计费口径：统计页把单价摊开展示，避免用户去翻文档 */
export const billingRates = () => ({
  searchPerCall: SEARCH_PER_CALL,
  parsePerPage: PARSE_PER_PAGE,
  ttsPerChar: TTS_PER_CHAR,
  asrPerSecond: ASR_PER_SECOND,
})

/** 北京时间的工作日高峰时段：9:00–12:00、14:00–18:00；节假日整体按空闲价 */
export const isPeakHour = (date: Date, holiday = false): boolean => {
  if (holiday) {
    return false
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? ''
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false
  }
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** 粗估 token：中文按 1 字 1 token，其余按 4 字符 1 token */
export const estimateTokens = (text: string): number => {
  let tokens = 0
  for (const char of text) {
    tokens += /[\u4e00-\u9fff]/.test(char) ? 1 : 0.25
  }
  return Math.ceil(tokens)
}

/** 按模型与时间取单价；未知模型按 flash 计 */
export type ModelPrice = { cacheHit: number; cacheMiss: number; output: number }

/** 本地模型（浏览器 WebLLM / 自建 MLC-LLM）不产生 API 费用 */
export const LOCAL_MODEL_PRICE: ModelPrice = { cacheHit: 0, cacheMiss: 0, output: 0 }

/** 未知模型按 Flash 价估算，避免云端模型没有价格时整段统计失效 */
export const modelPriceFor = (model: string): ModelPrice =>
  isLocalModel(model) ? LOCAL_MODEL_PRICE : (MODEL_PRICE[model] ?? MODEL_PRICE['deepseek-flash'])

/** 是否在官方价格表里；界面用它提示「未知模型按 Flash 估算」，本地模型视为已知（免费） */
export const isKnownModel = (model: string): boolean => isLocalModel(model) || model in MODEL_PRICE

/** 用服务端上报的用量算一次请求的费用（元） */
export const usageCost = (
  model: string,
  usage: MessageUsage,
  at: Date = new Date(),
  holiday = false
): number => {
  const price = modelPriceFor(model)
  const multiplier = isPeakHour(at, holiday) ? 2 : 1
  const tokens =
    (usage.cache_read_input_tokens ?? 0) * price.cacheHit +
    (usage.input_tokens ?? 0) * price.cacheMiss +
    (usage.output_tokens ?? 0) * price.output
  return (tokens * multiplier) / 1e6
}

/** 预估算一次请求的最坏费用：输入按未命中缓存、输出按上限 */
export const estimateRequestCost = (
  model: string,
  inputText: string,
  maxOutputTokens: number,
  at: Date = new Date(),
  holiday = false
): number => {
  const price = modelPriceFor(model)
  const multiplier = isPeakHour(at, holiday) ? 2 : 1
  const tokens = estimateTokens(inputText) * price.cacheMiss + maxOutputTokens * price.output
  return (tokens * multiplier) / 1e6
}

export type CostLine = {
  key: TranslationKey
  amount: number
  params?: TranslationParams
  /** 金额为 0 但仍要展示的 token 数（本地模型不计费，只统计用量） */
  tokens?: number
}

export type CostBreakdown = {
  lines: CostLine[]
  total: number
  /** 按当前时间判断现在是否高峰时段，用于面板上的状态标签 */
  peakNow: boolean
  /** 按模型分组的条数与费用，用于「分布计费」展示 */
  byModel: { model: string; replies: number; cost: number }[]
  usage: {
    cacheHit: number
    cacheMiss: number
    output: number
    search: number
    fetch: number
    pages: number
    ttsChars: number
    asrSeconds: number
    /** 本地模型（WebLLM / MLC-LLM）吃掉的 token，不计费 */
    localTokens: number
  }
}

/** 估算一个会话的费用；每条回复按它自己的请求时间判断高峰 / 空闲 */
export const estimateCost = (
  session: Session | null,
  options: {
    holiday?: boolean
    voiceDiscount?: boolean
    /** 服务端搜索 / 抓取是否免费；默认按 2026-11-18 12:00 起的新政策免费 */
    serverSearchFree?: boolean
  } = {}
): CostBreakdown => {
  const holiday = options.holiday ?? false
  const discount = options.voiceDiscount ?? true
  const searchFree = options.serverSearchFree ?? true
  const usage = {
    cacheHit: 0,
    cacheMiss: 0,
    output: 0,
    search: 0,
    fetch: 0,
    pages: 0,
    ttsChars: 0,
    asrSeconds: 0,
    localTokens: 0,
  }
  let modelCost = 0
  const modelTotals = new Map<string, { replies: number; cost: number }>()
  if (session) {
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (LAYOUT_EXTS.has(getExt(file.name))) {
            usage.pages += estimatePages(file.size)
          }
        }
        continue
      }
      if (message.role !== 'assistant') {
        continue
      }
      const reply = message as AssistantMessage
      const replyUsage = reply.usage
      if (!replyUsage) {
        continue
      }
      const model = reply.model ?? 'deepseek-flash'
      const price = modelPriceFor(model)
      const multiplier = isPeakHour(new Date(reply.createdAt), holiday) ? 2 : 1
      const replyCost =
        ((replyUsage.cache_read_input_tokens ?? 0) * price.cacheHit +
          (replyUsage.input_tokens ?? 0) * price.cacheMiss +
          (replyUsage.output_tokens ?? 0) * price.output) *
        multiplier
      modelCost += replyCost
      const entry = modelTotals.get(model) ?? { replies: 0, cost: 0 }
      entry.replies += 1
      entry.cost += replyCost
      modelTotals.set(model, entry)
      if (isLocalModel(model)) {
        usage.localTokens +=
          (replyUsage.cache_read_input_tokens ?? 0) +
          (replyUsage.input_tokens ?? 0) +
          (replyUsage.output_tokens ?? 0)
      }
      usage.cacheHit += replyUsage.cache_read_input_tokens ?? 0
      usage.cacheMiss += replyUsage.input_tokens ?? 0
      usage.output += replyUsage.output_tokens ?? 0
      usage.search +=
        replyUsage.server_tool_use?.web_search_requests ??
        reply.blocks.filter(
          (block) => block.type === 'server_tool_use' && block.name === 'deepseek_web_search'
        ).length
      usage.fetch += reply.blocks.filter(
        (block) => block.type === 'server_tool_use' && block.name === 'deepseek_read_url'
      ).length
    }
  }
  const voice = readVoiceUsage(session?.id ?? null)
  usage.ttsChars = voice.chars
  usage.asrSeconds = voice.seconds
  // 模型费用拆成三行展示，按比例还原：命中 / 未命中 / 输出在 token 上可拆，费用按各自单价单独算更直观
  const cacheHitCost = (() => {
    if (!session) {
      return 0
    }
    let sum = 0
    for (const message of session.messages) {
      if (message.role !== 'assistant' || !message.usage) {
        continue
      }
      const price = modelPriceFor(message.model ?? 'deepseek-flash')
      const multiplier = isPeakHour(new Date(message.createdAt), holiday) ? 2 : 1
      sum += (message.usage.cache_read_input_tokens ?? 0) * price.cacheHit * multiplier
    }
    return sum
  })()
  const cacheMissCost = (() => {
    if (!session) {
      return 0
    }
    let sum = 0
    for (const message of session.messages) {
      if (message.role !== 'assistant' || !message.usage) {
        continue
      }
      const price = modelPriceFor(message.model ?? 'deepseek-flash')
      const multiplier = isPeakHour(new Date(message.createdAt), holiday) ? 2 : 1
      sum += (message.usage.input_tokens ?? 0) * price.cacheMiss * multiplier
    }
    return sum
  })()
  const outputCost = modelCost - cacheHitCost - cacheMissCost
  // 新政策：模型调用触发的服务端搜索与抓取不再计费，只保留次数用于展示
  const searchCost = searchFree ? 0 : usage.search * SEARCH_PER_CALL
  const fetchCost = searchFree ? 0 : usage.fetch * SEARCH_PER_CALL
  const parseCost = usage.pages * PARSE_PER_PAGE
  const voiceFactor = discount ? 0.5 : 1
  const ttsCost = usage.ttsChars * TTS_PER_CHAR * voiceFactor
  const asrCost = usage.asrSeconds * ASR_PER_SECOND * voiceFactor
  const allLines: CostLine[] = [
    { key: 'billingInputHit', amount: cacheHitCost / 1e6 },
    { key: 'billingInputMiss', amount: cacheMissCost / 1e6 },
    { key: 'billingOutput', amount: outputCost / 1e6 },
    { key: 'billingSearch', amount: searchCost },
    { key: 'billingFetch', amount: fetchCost },
    { key: 'billingParse', amount: parseCost, params: { count: usage.pages } },
    { key: 'billingTts', amount: ttsCost },
    { key: 'billingAsr', amount: asrCost },
    {
      key: 'billingLocalTokens',
      amount: 0,
      tokens: usage.localTokens,
      params: { tokens: formatTokens(usage.localTokens) },
    },
  ]
  const lines = allLines.filter((line) => line.amount > 0 || (line.tokens ?? 0) > 0)
  return {
    lines,
    total: lines.reduce((sum, line) => sum + line.amount, 0),
    peakNow: isPeakHour(new Date(), holiday),
    byModel: [...modelTotals.entries()]
      .map(([model, entry]) => ({
        model,
        replies: entry.replies,
        cost: entry.cost / 1e6,
      }))
      .sort((a, b) => b.cost - a.cost),
    usage,
  }
}

/** 金额展示：小额保留 4 位，大额保留 2 位 */
export const formatMoney = (value: number): string => {
  if (value <= 0) {
    return '¥0'
  }
  if (value < 0.01) {
    return `¥${value.toFixed(4)}`
  }
  return `¥${value.toFixed(2)}`
}

/** token 紧凑写法：1280 / 12.8k / 1.28M */
export const formatTokens = (value: number): string => {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}k`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`
  }
  return String(value)
}
