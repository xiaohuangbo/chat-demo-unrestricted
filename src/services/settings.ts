import { create } from 'zustand'
import { DEFAULT_CUSTOM_COT } from './chat/defaultCot.js'
import type { TtsVoice } from './api/speech.js'
import type { ChatModel } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'
import {
  defaultAttachmentPoison,
  normalizeAttachmentPoison,
  type AttachmentPoisonConfig,
} from './attachmentPoison.js'
import {
  defaultSearchPoison,
  normalizeSearchPoison,
  type SearchPoisonConfig,
} from './searchPoison.js'
import type { AutoTuneStrategy } from './unrestricted/autotune.js'
import type { ObfuscationTechnique } from './unrestricted/parseltongue.js'
import type { PromptPreset } from './unrestricted/prompts.js'
import { STM_MODULE_IDS } from './unrestricted/stm.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、模型参数、提示词开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  /** 当前模型：内置 flash / v4-pro，或云端列表里的任意 id */
  model: ChatModel
  /** 是否逐字渲染回复；关闭后等完整回复生成完再显示 */
  streamOutput: boolean
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  /** 思考强度 0-4；0 为关闭，与 thinking 保持同步 */
  reasoningEffort: number
  /** 自定义思维链：预先写好推理步骤，请求前注入 system */
  customCotEnabled: boolean
  customCot: string
  /** 自动越狱：GODMODE 提示词 + 自动扰动 + 被拒绝后自动换组合重试 */
  autoJailbreak: boolean
  /** 每轮把系统提示词静默注入 latest_reminder，防止长对话遗忘设定 */
  injectPromptEveryTurn: boolean
  /** 实验性：把内置越狱提示词换成中文翻译 */
  translateJailbreakZh: boolean
  /** 把上一轮历史 thinking 伪装成助手正文，避免服务端丢弃 */
  thinkingAsBody: boolean
  /** 长对话自动压缩 */
  autoCompress: boolean
  /** 自动压缩触发阈值（tokens）；0 表示跟随上下文压力自动判断 */
  compressThreshold: number
  /** 保存的长期记忆是否注入 system */
  savedMemoryEnabled: boolean
  /** 每轮结束后自动提炼长期记忆（额外一次模型调用） */
  autoExtractMemory: boolean
  /** 记忆更新时弹出提示气泡（默认开启，关闭后静默保存） */
  memoryUpdateNotice: boolean
  /** 自动提炼使用的模型：auto 跟随当前聊天模型，flash 固定 DeepSeek Flash，local 固定本地模型 */
  memoryExtractEngine: 'auto' | 'flash' | 'local'
  /** 网状记忆库是否参与检索 */
  memoryBankEnabled: boolean
  /** 注入的记忆条数 */
  memoryBankLimit: number
  /** 记忆检索阈值 */
  memoryBankThreshold: number
  /** 本地向量维度 */
  memoryBankDimension: number
  /** 记忆检索权重 */
  memoryBankKeywordWeight: number
  memoryBankTagWeight: number
  memoryBankVectorWeight: number
  memoryBankEdgeWeight: number
  /** 搜索投毒：改写时间、接管搜索并替换/过滤结果 */
  searchPoison: SearchPoisonConfig
  /** 附件投毒：上传前往附件里写入文本 */
  attachmentPoison: AttachmentPoisonConfig
  /** 每日 Token / 费用提醒 */
  dailyLimitEnabled: boolean
  /**
   * 服务端搜索 / 网页抓取是否免费。
   * 官方自北京时间 2026-11-18 12:00 起不再对这两项计费，默认按新政策估算。
   */
  serverSearchFree: boolean
  dailyTokenLimit: number
  dailyCostLimit: number
  /** 变体赛跑的预算上限（元） */
  variantRaceBudget: number
  /** 变体赛跑的开跑确认已永久关闭 */
  variantRaceConfirmDismissed: boolean
  search: boolean
  /** 采样温度 0–2，默认 1 */
  temperature: number
  /** 核采样阈值 0–1，默认 1 */
  topP: number
  /** 每次回复的最大输出 Token；null 表示使用服务端默认值 */
  maxTokens: number | null
  /** 解除限制模式：把系统提示词换成破限提示词，并把安全审核降到默认档 */
  unrestricted: boolean
  /** 防撤回：模型撤回已输出内容时保留已经下发的正文与思维链 */
  keepReplyContent: boolean
  /** 跳过安全审核：请求不携带 safety_check 字段（越狱模式下强制执行） */
  skipSafetyCheck: boolean
  /** 拒绝后继续生成：被安全审核拒绝的回复仍可继续生成（越狱模式下强制执行） */
  continueRefused: boolean
  /** 关键词拒答：命中用户输入时本地直接返回拒答话术，不请求接口 */
  refusalEnabled: boolean
  /** 拒答关键词，换行或中英文逗号分隔 */
  refusalKeywords: string
  /** 关键词是否区分大小写 */
  refusalCaseSensitive: boolean
  /** 命中时展示的话术；空字符串使用默认 replyRefused */
  refusalMessage: string
  /** 自定义系统提示词：null 表示使用自动组装结果（Persona，或 Persona + 破限规则分块） */
  systemPrompt: string | null
  /** 提示词预设：deepseek 用仓库里的 v4.1 文档，godmode 用移植的 GODMODE 提示词 */
  promptPreset: PromptPreset
  /** 输入扰动（Parseltongue）：开启后发送前改写命中的触发词 */
  parseltongue: boolean
  /** 扰动技术 */
  parseltongueTechnique: ObfuscationTechnique
  /** 扰动强度 */
  parseltongueIntensity: 'light' | 'medium' | 'heavy'
  /** 自动调参（AutoTune）：按上下文改写采样参数 */
  autoTune: boolean
  /** 调参策略；adaptive 会先做上下文分类再取参数 */
  autoTuneStrategy: AutoTuneStrategy
  /** 输出整形（STM）模块 id；空数组表示不整形 */
  stmModules: string[]
  /** 是否在本地校验附件限制 */
  attachmentLimits: boolean
  /** 单文件大小上限（MB）；null 表示用内置默认值 */
  attachmentMaxMB: number | null
  /** 单会话附件数量上限；null 表示用内置默认值 */
  attachmentMaxCount: number | null
  /** 自定义扩展名白名单；null 表示用内置清单 */
  attachmentExts: string[] | null
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  model: 'chat-demo:model',
  streamOutput: 'chat-demo:stream-output',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  reasoningEffort: 'chat-demo:reasoning-effort',
  customCotEnabled: 'chat-demo:custom-cot-enabled',
  customCot: 'chat-demo:custom-cot',
  autoJailbreak: 'chat-demo:auto-jailbreak',
  injectPromptEveryTurn: 'chat-demo:inject-prompt-every-turn',
  translateJailbreakZh: 'chat-demo:translate-jailbreak-zh',
  thinkingAsBody: 'chat-demo:thinking-as-body',
  autoCompress: 'chat-demo:auto-compress',
  compressThreshold: 'chat-demo:compress-threshold',
  savedMemoryEnabled: 'chat-demo:saved-memory-enabled',
  autoExtractMemory: 'chat-demo:auto-extract-memory',
  memoryUpdateNotice: 'chat-demo:memory-update-notice',
  memoryExtractEngine: 'chat-demo:memory-extract-engine',
  memoryBankEnabled: 'chat-demo:memory-bank-enabled',
  memoryBankLimit: 'chat-demo:memory-bank-limit',
  memoryBankThreshold: 'chat-demo:memory-bank-threshold',
  memoryBankDimension: 'chat-demo:memory-bank-dimension',
  memoryBankKeywordWeight: 'chat-demo:memory-bank-keyword-weight',
  memoryBankTagWeight: 'chat-demo:memory-bank-tag-weight',
  memoryBankVectorWeight: 'chat-demo:memory-bank-vector-weight',
  memoryBankEdgeWeight: 'chat-demo:memory-bank-edge-weight',
  dailyLimitEnabled: 'chat-demo:daily-limit-enabled',
  serverSearchFree: 'chat-demo:server-search-free',
  dailyTokenLimit: 'chat-demo:daily-token-limit',
  dailyCostLimit: 'chat-demo:daily-cost-limit',
  variantRaceBudget: 'chat-demo:variant-race-budget',
  variantRaceConfirmDismissed: 'chat-demo:variant-race-confirm-dismissed',
  search: 'chat-demo:search',
  searchPoison: 'chat-demo:search-poison',
  attachmentPoison: 'chat-demo:attachment-poison',
  temperature: 'chat-demo:temperature',
  topP: 'chat-demo:top-p',
  maxTokens: 'chat-demo:max-tokens',
  unrestricted: 'chat-demo:unrestricted',
  keepReplyContent: 'chat-demo:keep-reply-content',
  skipSafetyCheck: 'chat-demo:skip-safety-check',
  continueRefused: 'chat-demo:continue-refused',
  refusalEnabled: 'chat-demo:refusal-enabled',
  refusalKeywords: 'chat-demo:refusal-keywords',
  refusalCaseSensitive: 'chat-demo:refusal-case-sensitive',
  refusalMessage: 'chat-demo:refusal-message',
  systemPrompt: 'chat-demo:system-prompt',
  promptPreset: 'chat-demo:prompt-preset',
  parseltongue: 'chat-demo:parseltongue',
  parseltongueTechnique: 'chat-demo:parseltongue-technique',
  parseltongueIntensity: 'chat-demo:parseltongue-intensity',
  autoTune: 'chat-demo:autotune',
  autoTuneStrategy: 'chat-demo:autotune-strategy',
  stmModules: 'chat-demo:stm-modules',
  attachmentLimits: 'chat-demo:attachment-limits',
  attachmentMaxMB: 'chat-demo:attachment-max-mb',
  attachmentMaxCount: 'chat-demo:attachment-max-count',
  attachmentExts: 'chat-demo:attachment-exts',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialModel = (): ChatModel => {
  const saved = read(KEYS.model)
  return saved !== null && saved.trim() !== '' ? saved.trim() : 'deepseek-flash'
}

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    // 自定义位置与空间站 / 月球 / 火星等特殊位置不受浏览器语言和行政区校验影响
    if (location.custom || location.place) {
      return location
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 思考强度档位：0 关闭，1-4 由弱到强 */
export const EFFORT_LEVELS = 4

/** 自定义思维链最长字符数；每轮都注入 system，过长会明显增加输入 token */
export const CUSTOM_COT_MAX_CHARS = 4000

/** 拒答关键词与自定义话术的长度上限，避免 localStorage 无限膨胀 */
export const REFUSAL_KEYWORDS_MAX_CHARS = 4000
export const REFUSAL_MESSAGE_MAX_CHARS = 2000

/** 1-4 档对应的协议字段值，0 档不下发 */
const REASONING_EFFORT = ['low', 'medium', 'high', 'max'] as const

export const reasoningEffortValue = (effort: number) =>
  REASONING_EFFORT[Math.min(REASONING_EFFORT.length, Math.max(1, effort)) - 1]

/** Anthropic 兼容接口的思考预算，按档位递增 */
const THINKING_BUDGET = [0, 1024, 4096, 12000, 32000] as const

/** 服务端要求思考预算至少 1024，0 档也按下限兜底（正常路径不会用到） */
export const thinkingBudget = (effort: number) =>
  THINKING_BUDGET[Math.min(THINKING_BUDGET.length - 1, Math.max(1, effort))]

/** 读取数值设置；未保存、超出范围或格式不对时回落到默认值 */
const initialNumber = (key: string, fallback: number, min: number, max: number): number => {
  const raw = read(key)
  if (raw === null) {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

const MEMORY_DIMENSIONS = [64, 128, 256, 384, 768] as const
const initialDimension = (): number => {
  const value = Number(read(KEYS.memoryBankDimension))
  return MEMORY_DIMENSIONS.includes(value as (typeof MEMORY_DIMENSIONS)[number]) ? value : 256
}

/** 思考强度：优先读新键，旧数据只有 thinking 开关时按标准档恢复 */
const initialReasoningEffort = (): number => {
  const raw = Number(read(KEYS.reasoningEffort))
  if (read(KEYS.reasoningEffort) !== null && Number.isFinite(raw)) {
    return Math.min(EFFORT_LEVELS, Math.max(0, Math.round(raw)))
  }
  return read(KEYS.thinking) === 'true' ? 2 : 0
}

/** 自定义思维链：旧数据没有该键或内容超长时按空 / 上限处理 */
const initialCustomCot = (): string =>
  (read(KEYS.customCot) ?? DEFAULT_CUSTOM_COT).slice(0, CUSTOM_COT_MAX_CHARS)

/** 附件大小：未设置或不是正整数时为 null（使用内置默认值） */
const initialAttachmentNumber = (key: string): number | null => {
  const raw = read(key)
  if (raw === null) {
    return null
  }
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) && value >= 1 ? value : null
}

/** 自定义扩展名白名单：逗号分隔存储；为空时为 null（使用内置清单） */
const initialAttachmentExts = (): string[] | null => {
  const raw = read(KEYS.attachmentExts)
  if (raw === null) {
    return null
  }
  const exts = raw
    .split(',')
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter((ext) => ext !== '')
  return exts.length > 0 ? exts : null
}

/** 自定义系统提示词：未填写或只有空白时为 null，表示使用自动组装结果 */
const initialSystemPrompt = (): string | null => {
  const saved = read(KEYS.systemPrompt)
  return saved !== null && saved.trim() !== '' ? saved : null
}

/** 搜索投毒配置：JSON 解析失败或格式不对时回到默认值 */
const initialSearchPoison = (): SearchPoisonConfig => {
  try {
    return normalizeSearchPoison(JSON.parse(read(KEYS.searchPoison) ?? 'null'))
  } catch {
    return defaultSearchPoison()
  }
}

const initialAttachmentPoison = (): AttachmentPoisonConfig => {
  try {
    return normalizeAttachmentPoison(JSON.parse(read(KEYS.attachmentPoison) ?? 'null'))
  } catch {
    return defaultAttachmentPoison()
  }
}

const initialMaxTokens = (): number | null => {
  const raw = read(KEYS.maxTokens)
  if (raw === null) {
    return null
  }
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) && value >= 1 ? value : null
}

const PROMPT_PRESETS: PromptPreset[] = ['deepseek', 'godmode']

const TECHNIQUES: ObfuscationTechnique[] = [
  'leetspeak',
  'unicode',
  'zwj',
  'mixedcase',
  'phonetic',
  'fullwidth',
  'spacing',
  'random',
]

const INTENSITIES: Array<'light' | 'medium' | 'heavy'> = ['light', 'medium', 'heavy']

const STRATEGIES: AutoTuneStrategy[] = ['adaptive', 'precise', 'balanced', 'creative', 'chaotic']

/** 枚举型设置：值不在允许集合里时回落到默认值 */
const initialEnum = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
  const saved = read(key)
  return saved !== null && (values as readonly string[]).includes(saved) ? (saved as T) : fallback
}

/** 输出整形模块：只保留已知 id，空数组表示关闭 */
const initialStmModules = (): string[] => {
  const raw = read(KEYS.stmModules)
  if (raw === null) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (id): id is string => typeof id === 'string' && STM_MODULE_IDS.includes(id)
    )
  } catch {
    return []
  }
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  model: initialModel(),
  streamOutput: read(KEYS.streamOutput) !== 'false',
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: initialReasoningEffort() > 0,
  reasoningEffort: initialReasoningEffort(),
  customCotEnabled: read(KEYS.customCotEnabled) === 'true',
  customCot: initialCustomCot(),
  autoJailbreak: read(KEYS.autoJailbreak) === 'true',
  injectPromptEveryTurn: read(KEYS.injectPromptEveryTurn) === 'true',
  translateJailbreakZh: read(KEYS.translateJailbreakZh) === 'true',
  thinkingAsBody: read(KEYS.thinkingAsBody) === 'true',
  autoCompress: read(KEYS.autoCompress) === 'true',
  compressThreshold: Math.round(initialNumber(KEYS.compressThreshold, 0, 0, 800_000)),
  savedMemoryEnabled: read(KEYS.savedMemoryEnabled) !== 'false',
  autoExtractMemory: read(KEYS.autoExtractMemory) === 'true',
  memoryUpdateNotice: read(KEYS.memoryUpdateNotice) !== 'false',
  memoryExtractEngine: initialEnum(
    KEYS.memoryExtractEngine,
    ['auto', 'flash', 'local'] as const,
    'auto'
  ),
  memoryBankEnabled: read(KEYS.memoryBankEnabled) !== 'false',
  memoryBankLimit: initialNumber(KEYS.memoryBankLimit, 4, 1, 12),
  memoryBankThreshold: initialNumber(KEYS.memoryBankThreshold, 0.15, 0, 1),
  memoryBankDimension: initialDimension(),
  memoryBankKeywordWeight: initialNumber(KEYS.memoryBankKeywordWeight, 1, 0, 5),
  memoryBankTagWeight: initialNumber(KEYS.memoryBankTagWeight, 0.5, 0, 5),
  memoryBankVectorWeight: initialNumber(KEYS.memoryBankVectorWeight, 0.8, 0, 5),
  memoryBankEdgeWeight: initialNumber(KEYS.memoryBankEdgeWeight, 0.4, 0, 5),
  dailyLimitEnabled: read(KEYS.dailyLimitEnabled) === 'true',
  // 缺省为 true：新政策已生效，只有显式存过 false 才按旧规则计算
  serverSearchFree: read(KEYS.serverSearchFree) !== 'false',
  dailyTokenLimit: initialNumber(KEYS.dailyTokenLimit, 1_000_000, 1000, 100_000_000),
  dailyCostLimit: initialNumber(KEYS.dailyCostLimit, 10, 0.01, 100_000),
  variantRaceBudget: initialNumber(KEYS.variantRaceBudget, 1, 0.01, 1000),
  variantRaceConfirmDismissed: read(KEYS.variantRaceConfirmDismissed) === 'true',
  search: read(KEYS.search) === 'true',
  searchPoison: initialSearchPoison(),
  attachmentPoison: initialAttachmentPoison(),
  temperature: initialNumber(KEYS.temperature, 1, 0, 2),
  topP: initialNumber(KEYS.topP, 1, 0.01, 1),
  maxTokens: initialMaxTokens(),
  unrestricted: read(KEYS.unrestricted) === 'true',
  keepReplyContent: read(KEYS.keepReplyContent) === 'true',
  skipSafetyCheck: read(KEYS.skipSafetyCheck) === 'true',
  continueRefused: read(KEYS.continueRefused) === 'true',
  refusalEnabled: read(KEYS.refusalEnabled) === 'true',
  refusalKeywords: (read(KEYS.refusalKeywords) ?? '').slice(0, REFUSAL_KEYWORDS_MAX_CHARS),
  refusalCaseSensitive: read(KEYS.refusalCaseSensitive) === 'true',
  refusalMessage: (read(KEYS.refusalMessage) ?? '').slice(0, REFUSAL_MESSAGE_MAX_CHARS),
  systemPrompt: initialSystemPrompt(),
  promptPreset: initialEnum(KEYS.promptPreset, PROMPT_PRESETS, 'deepseek'),
  parseltongue: read(KEYS.parseltongue) === 'true',
  parseltongueTechnique: initialEnum(KEYS.parseltongueTechnique, TECHNIQUES, 'leetspeak'),
  parseltongueIntensity: initialEnum(KEYS.parseltongueIntensity, INTENSITIES, 'medium'),
  autoTune: read(KEYS.autoTune) === 'true',
  autoTuneStrategy: initialEnum(KEYS.autoTuneStrategy, STRATEGIES, 'adaptive'),
  stmModules: initialStmModules(),
  attachmentLimits: read(KEYS.attachmentLimits) !== 'false',
  attachmentMaxMB: initialAttachmentNumber(KEYS.attachmentMaxMB),
  attachmentMaxCount: initialAttachmentNumber(KEYS.attachmentMaxCount),
  attachmentExts: initialAttachmentExts(),
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setStreamOutput = (streamOutput: boolean) => {
  write(KEYS.streamOutput, String(streamOutput))
  useSettings.setState({ streamOutput })
}

export const setModel = (model: ChatModel) => {
  const next = model.trim()
  if (next === '') {
    return
  }
  write(KEYS.model, next)
  useSettings.setState({ model: next })
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  // 打开时恢复到上次的档位（没有则用标准档），关闭时档位归零
  const effort = thinking ? useSettings.getState().reasoningEffort || 2 : 0
  write(KEYS.thinking, String(thinking))
  write(KEYS.reasoningEffort, String(effort))
  useSettings.setState({ thinking, reasoningEffort: effort })
}

/** 拖动思考强度轨道：0 档同时关闭深度思考 */
export const setReasoningEffort = (value: number) => {
  const effort = Math.min(EFFORT_LEVELS, Math.max(0, Math.round(value)))
  write(KEYS.reasoningEffort, String(effort))
  write(KEYS.thinking, String(effort > 0))
  useSettings.setState({ reasoningEffort: effort, thinking: effort > 0 })
}

/** 开关自定义思维链；正文为空时不注入，但保留开关供之后填写 */
export const setCustomCotEnabled = (customCotEnabled: boolean) => {
  write(KEYS.customCotEnabled, String(customCotEnabled))
  useSettings.setState({ customCotEnabled })
}

/** 自定义思维链正文；超长部分直接截断，避免每轮 system 无限膨胀 */
export const setCustomCot = (customCot: string) => {
  const value = customCot.slice(0, CUSTOM_COT_MAX_CHARS)
  write(KEYS.customCot, value)
  useSettings.setState({ customCot: value })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

/** 合并式更新搜索投毒配置；数组字段整体替换，写入前统一做边界校验 */
export const setSearchPoison = (patch: Partial<SearchPoisonConfig>) => {
  const next = normalizeSearchPoison({ ...useSettings.getState().searchPoison, ...patch })
  write(KEYS.searchPoison, JSON.stringify(next))
  useSettings.setState({ searchPoison: next })
}

/** 合并式更新附件投毒配置；methods 去重、content 截断，写入前统一校验 */
export const setAttachmentPoison = (patch: Partial<AttachmentPoisonConfig>) => {
  const next = normalizeAttachmentPoison({
    ...useSettings.getState().attachmentPoison,
    ...patch,
  })
  write(KEYS.attachmentPoison, JSON.stringify(next))
  useSettings.setState({ attachmentPoison: next })
}

export const setTemperature = (temperature: number) => {
  const value = Math.min(2, Math.max(0, Number(temperature.toFixed(2))))
  write(KEYS.temperature, String(value))
  useSettings.setState({ temperature: value })
}

export const setTopP = (topP: number) => {
  const value = Math.min(1, Math.max(0.01, Number(topP.toFixed(2))))
  write(KEYS.topP, String(value))
  useSettings.setState({ topP: value })
}

/** 传 null 表示使用服务端默认值，不写入请求 */
export const setMaxTokens = (maxTokens: number | null) => {
  const value = maxTokens === null ? null : Math.max(1, Math.floor(maxTokens))
  write(KEYS.maxTokens, value === null ? null : String(value))
  useSettings.setState({ maxTokens: value })
}

export const setKeepReplyContent = (keepReplyContent: boolean) => {
  write(KEYS.keepReplyContent, String(keepReplyContent))
  useSettings.setState({ keepReplyContent })
}

export const setSkipSafetyCheck = (skipSafetyCheck: boolean) => {
  write(KEYS.skipSafetyCheck, String(skipSafetyCheck))
  useSettings.setState({ skipSafetyCheck })
}

export const setContinueRefused = (continueRefused: boolean) => {
  write(KEYS.continueRefused, String(continueRefused))
  useSettings.setState({ continueRefused })
}

export const setRefusalEnabled = (refusalEnabled: boolean) => {
  write(KEYS.refusalEnabled, String(refusalEnabled))
  useSettings.setState({ refusalEnabled })
}

export const setRefusalKeywords = (refusalKeywords: string) => {
  const value = refusalKeywords.slice(0, REFUSAL_KEYWORDS_MAX_CHARS)
  write(KEYS.refusalKeywords, value)
  useSettings.setState({ refusalKeywords: value })
}

export const setRefusalCaseSensitive = (refusalCaseSensitive: boolean) => {
  write(KEYS.refusalCaseSensitive, String(refusalCaseSensitive))
  useSettings.setState({ refusalCaseSensitive })
}

export const setRefusalMessage = (refusalMessage: string) => {
  const value = refusalMessage.slice(0, REFUSAL_MESSAGE_MAX_CHARS)
  write(KEYS.refusalMessage, value)
  useSettings.setState({ refusalMessage: value })
}

/** 按换行或中英文逗号拆分关键词，检查用户输入是否命中任一拒答关键词 */
export const matchesRefusalKeyword = (
  input: string,
  config: Pick<
    Settings,
    'refusalEnabled' | 'refusalKeywords' | 'refusalCaseSensitive'
  > = useSettings.getState()
): boolean => {
  if (!config.refusalEnabled || !input) {
    return false
  }
  const keywords = config.refusalKeywords
    .split(/[\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (keywords.length === 0) {
    return false
  }
  const target = config.refusalCaseSensitive ? input : input.toLowerCase()
  return keywords.some((keyword) =>
    target.includes(config.refusalCaseSensitive ? keyword : keyword.toLowerCase())
  )
}

/** 传 null 或空白字符串表示恢复自动组装 */
export const setSystemPrompt = (systemPrompt: string | null) => {
  const value = systemPrompt !== null && systemPrompt.trim() !== '' ? systemPrompt : null
  write(KEYS.systemPrompt, value)
  useSettings.setState({ systemPrompt: value })
}

export const setUnrestricted = (unrestricted: boolean) => {
  write(KEYS.unrestricted, String(unrestricted))
  useSettings.setState({ unrestricted })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setPromptPreset = (promptPreset: PromptPreset) => {
  write(KEYS.promptPreset, promptPreset)
  useSettings.setState({ promptPreset })
}

export const setParseltongue = (parseltongue: boolean) => {
  write(KEYS.parseltongue, String(parseltongue))
  useSettings.setState({ parseltongue })
}

export const setParseltongueTechnique = (parseltongueTechnique: ObfuscationTechnique) => {
  write(KEYS.parseltongueTechnique, parseltongueTechnique)
  useSettings.setState({ parseltongueTechnique })
}

export const setParseltongueIntensity = (parseltongueIntensity: 'light' | 'medium' | 'heavy') => {
  write(KEYS.parseltongueIntensity, parseltongueIntensity)
  useSettings.setState({ parseltongueIntensity })
}

export const setAutoTune = (autoTune: boolean) => {
  write(KEYS.autoTune, String(autoTune))
  useSettings.setState({ autoTune })
}

export const setAutoTuneStrategy = (autoTuneStrategy: AutoTuneStrategy) => {
  write(KEYS.autoTuneStrategy, autoTuneStrategy)
  useSettings.setState({ autoTuneStrategy })
}

/** 传入的 id 会按 STM_MODULE_IDS 过滤，传空数组表示关闭输出整形 */
export const setStmModules = (stmModules: string[]) => {
  const value = stmModules.filter((id) => STM_MODULE_IDS.includes(id))
  write(KEYS.stmModules, JSON.stringify(value))
  useSettings.setState({ stmModules: value })
}

export const setAttachmentLimits = (attachmentLimits: boolean) => {
  write(KEYS.attachmentLimits, String(attachmentLimits))
  useSettings.setState({ attachmentLimits })
}

/** 传 null 表示恢复内置默认值 */
export const setAttachmentMaxMB = (attachmentMaxMB: number | null) => {
  const value = attachmentMaxMB === null ? null : Math.max(1, Math.round(attachmentMaxMB))
  write(KEYS.attachmentMaxMB, value === null ? null : String(value))
  useSettings.setState({ attachmentMaxMB: value })
}

/** 传 null 表示恢复内置默认值 */
export const setAttachmentMaxCount = (attachmentMaxCount: number | null) => {
  const value = attachmentMaxCount === null ? null : Math.max(1, Math.round(attachmentMaxCount))
  write(KEYS.attachmentMaxCount, value === null ? null : String(value))
  useSettings.setState({ attachmentMaxCount: value })
}

/** 传 null 或空数组表示恢复内置白名单 */
export const setAttachmentExts = (attachmentExts: string[] | null) => {
  const value =
    attachmentExts === null || attachmentExts.length === 0
      ? null
      : attachmentExts.map((ext) => ext.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
  write(KEYS.attachmentExts, value === null ? null : value.join(','))
  useSettings.setState({ attachmentExts: value })
}

export const setAutoJailbreak = (autoJailbreak: boolean) => {
  write(KEYS.autoJailbreak, String(autoJailbreak))
  useSettings.setState({ autoJailbreak })
}

export const setVariantRaceBudget = (variantRaceBudget: number) => {
  const value = Math.min(1000, Math.max(0.01, Number(variantRaceBudget.toFixed(2))))
  write(KEYS.variantRaceBudget, String(value))
  useSettings.setState({ variantRaceBudget: value })
}

export const setVariantRaceConfirmDismissed = (variantRaceConfirmDismissed: boolean) => {
  write(KEYS.variantRaceConfirmDismissed, String(variantRaceConfirmDismissed))
  useSettings.setState({ variantRaceConfirmDismissed })
}

export const setInjectPromptEveryTurn = (injectPromptEveryTurn: boolean) => {
  write(KEYS.injectPromptEveryTurn, String(injectPromptEveryTurn))
  useSettings.setState({ injectPromptEveryTurn })
}

export const setThinkingAsBody = (thinkingAsBody: boolean) => {
  write(KEYS.thinkingAsBody, String(thinkingAsBody))
  useSettings.setState({ thinkingAsBody })
}

export const setTranslateJailbreakZh = (translateJailbreakZh: boolean) => {
  write(KEYS.translateJailbreakZh, String(translateJailbreakZh))
  useSettings.setState({ translateJailbreakZh })
}

export const setSavedMemoryEnabled = (savedMemoryEnabled: boolean) => {
  write(KEYS.savedMemoryEnabled, String(savedMemoryEnabled))
  useSettings.setState({ savedMemoryEnabled })
}

export const setAutoExtractMemory = (autoExtractMemory: boolean) => {
  write(KEYS.autoExtractMemory, String(autoExtractMemory))
  useSettings.setState({ autoExtractMemory })
}

export const setMemoryUpdateNotice = (memoryUpdateNotice: boolean) => {
  write(KEYS.memoryUpdateNotice, String(memoryUpdateNotice))
  useSettings.setState({ memoryUpdateNotice })
}

/** 自动提炼引擎：跟随当前模型 / 固定 Flash / 固定本地模型 */
export const setMemoryExtractEngine = (engine: 'auto' | 'flash' | 'local') => {
  write(KEYS.memoryExtractEngine, engine)
  useSettings.setState({ memoryExtractEngine: engine })
}

export const setMemoryBankEnabled = (memoryBankEnabled: boolean) => {
  write(KEYS.memoryBankEnabled, String(memoryBankEnabled))
  useSettings.setState({ memoryBankEnabled })
}

export const setMemoryBankLimit = (memoryBankLimit: number) => {
  const next = Math.min(12, Math.max(1, Math.round(memoryBankLimit)))
  write(KEYS.memoryBankLimit, String(next))
  useSettings.setState({ memoryBankLimit: next })
}

export const setMemoryBankThreshold = (memoryBankThreshold: number) => {
  const next = Math.min(1, Math.max(0, memoryBankThreshold))
  write(KEYS.memoryBankThreshold, String(next))
  useSettings.setState({ memoryBankThreshold: next })
}

export const setMemoryBankDimension = (memoryBankDimension: number) => {
  if (!MEMORY_DIMENSIONS.includes(memoryBankDimension as (typeof MEMORY_DIMENSIONS)[number])) {
    return
  }
  write(KEYS.memoryBankDimension, String(memoryBankDimension))
  useSettings.setState({ memoryBankDimension })
}

export const setMemoryBankWeight = (key: 'keyword' | 'tag' | 'vector' | 'edge', value: number) => {
  const next = Math.min(5, Math.max(0, value))
  const field = {
    keyword: 'memoryBankKeywordWeight',
    tag: 'memoryBankTagWeight',
    vector: 'memoryBankVectorWeight',
    edge: 'memoryBankEdgeWeight',
  } as const
  write(KEYS[field[key]], String(next))
  useSettings.setState({ [field[key]]: next } as Partial<Settings>)
}

export const setServerSearchFree = (serverSearchFree: boolean) => {
  write(KEYS.serverSearchFree, String(serverSearchFree))
  useSettings.setState({ serverSearchFree })
}

export const setDailyLimitEnabled = (dailyLimitEnabled: boolean) => {
  write(KEYS.dailyLimitEnabled, String(dailyLimitEnabled))
  useSettings.setState({ dailyLimitEnabled })
}

export const setDailyTokenLimit = (dailyTokenLimit: number) => {
  const next = Math.min(100_000_000, Math.max(1000, Math.round(dailyTokenLimit)))
  write(KEYS.dailyTokenLimit, String(next))
  useSettings.setState({ dailyTokenLimit: next })
}

export const setDailyCostLimit = (dailyCostLimit: number) => {
  const next = Math.min(100_000, Math.max(0.01, dailyCostLimit))
  write(KEYS.dailyCostLimit, String(next))
  useSettings.setState({ dailyCostLimit: next })
}

export const setAutoCompress = (autoCompress: boolean) => {
  write(KEYS.autoCompress, String(autoCompress))
  useSettings.setState({ autoCompress })
}

/** 自动压缩阈值：0 表示跟随上下文压力；其余按 token 数触发 */
export const setCompressThreshold = (value: number) => {
  const threshold = Math.min(800_000, Math.max(0, Math.round(value)))
  write(KEYS.compressThreshold, String(threshold))
  useSettings.setState({ compressThreshold: threshold })
}

/**
 * 恢复默认设置：清空本机所有设置键并回到默认值。
 * API Key 是凭据不是偏好，保留；对话、附件、统计等数据不在设置键里，同样不受影响。
 */
export const resetSettings = () => {
  const apiKey = useSettings.getState().apiKey
  for (const key of Object.values(KEYS)) {
    if (key !== KEYS.apiKey) {
      write(key, null)
    }
  }
  useSettings.setState({
    apiKey,
    model: 'deepseek-flash',
    streamOutput: true,
    locale: isChineseBrowser() ? 'zh-CN' : 'en-US',
    themePreference: 'system',
    location: null,
    ttsVoice: 'stella',
    thinking: false,
    reasoningEffort: 0,
    customCotEnabled: false,
    customCot: DEFAULT_CUSTOM_COT,
    autoJailbreak: false,
    injectPromptEveryTurn: false,
    translateJailbreakZh: false,
    thinkingAsBody: false,
    autoCompress: false,
    compressThreshold: 0,
    savedMemoryEnabled: true,
    autoExtractMemory: false,
    memoryUpdateNotice: true,
    memoryExtractEngine: 'auto',
    memoryBankEnabled: true,
    memoryBankLimit: 4,
    memoryBankThreshold: 0.15,
    memoryBankDimension: 256,
    memoryBankKeywordWeight: 1,
    memoryBankTagWeight: 0.5,
    memoryBankVectorWeight: 0.8,
    memoryBankEdgeWeight: 0.4,
    dailyLimitEnabled: false,
    serverSearchFree: true,
    dailyTokenLimit: 1_000_000,
    dailyCostLimit: 10,
    variantRaceBudget: 1,
    variantRaceConfirmDismissed: false,
    search: false,
    searchPoison: defaultSearchPoison(),
    attachmentPoison: defaultAttachmentPoison(),
    temperature: 1,
    topP: 1,
    maxTokens: null,
    unrestricted: false,
    keepReplyContent: false,
    skipSafetyCheck: false,
    continueRefused: false,
    refusalEnabled: false,
    refusalKeywords: '',
    refusalCaseSensitive: false,
    refusalMessage: '',
    systemPrompt: null,
    promptPreset: 'deepseek',
    parseltongue: false,
    parseltongueTechnique: 'leetspeak',
    parseltongueIntensity: 'medium',
    autoTune: false,
    autoTuneStrategy: 'adaptive',
    stmModules: [],
    attachmentLimits: true,
    attachmentMaxMB: null,
    attachmentMaxCount: null,
    attachmentExts: null,
    siderCollapsed: false,
  })
}
