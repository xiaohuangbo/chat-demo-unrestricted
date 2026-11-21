import { API_ORIGIN } from './client.js'
import {
  findLocalModel,
  isLocalModel,
  isMlcModel,
  isWebllmModel,
  mlcModelId,
  webllmModelId,
} from '../local/catalog.js'
import { shortModelName } from '../local/mlcApi.js'

/**
 * 模型列表：默认使用内置 DeepSeek Flash / V4 Pro，
 * 也可以从云端 GET /models 拉取可用模型并缓存一小时。
 * 远端 id 原样透传给请求，计费未知时按 Flash 价估算。
 */

export type ModelOption = {
  id: string
  label: string
  /**
   * remote：云端 /models 拉到的模型；builtin：内置 Flash / V4 Pro；
   * local：浏览器内 WebLLM 已下载模型；mlc：远端 MLC-LLM API 提供的模型
   */
  source: 'remote' | 'builtin' | 'local' | 'mlc'
}

export const BUILTIN_MODELS: ModelOption[] = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash', source: 'builtin' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', source: 'builtin' },
]

/**
 * V4 Pro 不提供服务端联网工具（deepseek_web_search / deepseek_read_url）与标题生成，
 * 请求里带任一项会直接返回 invalid_request_error；客户端工具与普通聊天不受影响。
 * 需要联网搜索或服务端标题时请使用 deepseek-flash。
 */
const MODELS_WITHOUT_SERVER_FEATURES = new Set(['deepseek-v4-pro'])

export const supportsServerTools = (model: string): boolean =>
  !MODELS_WITHOUT_SERVER_FEATURES.has(model)

export const supportsServerTitle = (model: string): boolean =>
  !MODELS_WITHOUT_SERVER_FEATURES.has(model)

const CACHE_KEY = 'chat-demo:models-cache'
/** 缓存一小时；「从云端获取」会强制刷新 */
const CACHE_TTL = 60 * 60 * 1000
/** 拉取超时，避免网络挂起时选择器一直转圈 */
const FETCH_TIMEOUT = 8000

type Cached = { at: number; models: ModelOption[] }

/** 把 deepseek-v4-pro 之类的 id 整理成可读名称 */
export const prettyModelName = (id: string): string =>
  id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(' ')

/** 本地模型的展示名：WebLLM 用「家族 + 型号」，MLC-LLM API 用服务端 id 的最后一段 */
export const modelLabel = (id: string): string => {
  if (isWebllmModel(id)) {
    const info = findLocalModel(webllmModelId(id))
    return info ? `${info.familyLabel} ${info.name}` : shortModelName(webllmModelId(id))
  }
  if (isMlcModel(id)) {
    return shortModelName(mlcModelId(id))
  }
  return BUILTIN_MODELS.find((item) => item.id === id)?.label ?? prettyModelName(id)
}

/** 本地模型的来源标签，聊天栏与设置页共用 */
export const modelSource = (id: string): 'cloud' | 'local' | 'mlc' =>
  isLocalModel(id) ? (isWebllmModel(id) ? 'local' : 'mlc') : 'cloud'

export const readCachedModels = (): ModelOption[] | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Cached
    if (!Array.isArray(parsed.models) || Date.now() - parsed.at > CACHE_TTL) {
      return null
    }
    return parsed.models.filter(
      (item): item is ModelOption =>
        typeof item?.id === 'string' &&
        typeof item?.label === 'string' &&
        (item.source === 'remote' || item.source === 'builtin')
    )
  } catch {
    return null
  }
}

const writeCache = (models: ModelOption[]) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), models }))
  } catch {
    // 隐私模式下写入失败不影响本次选择
  }
}

/** 兼容 OpenAI 的 {data:[{id}]} 与部分实现的 {models:[...]} */
const parseModels = (payload: unknown): ModelOption[] => {
  if (typeof payload !== 'object' || payload === null) {
    return []
  }
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const seen = new Set<string>()
  return list.flatMap((item): ModelOption[] => {
    if (typeof item === 'string') {
      return [{ id: item, label: prettyModelName(item), source: 'remote' as const }]
    }
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const entry = item as Record<string, unknown>
    const id =
      typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : ''
    if (!id || seen.has(id)) {
      return []
    }
    seen.add(id)
    const label =
      (typeof entry.display_name === 'string' && entry.display_name) ||
      (typeof entry.displayName === 'string' && entry.displayName) ||
      prettyModelName(id)
    return [{ id, label, source: 'remote' as const }]
  })
}

const requestJson = async (url: string, headers: Record<string, string>): Promise<unknown> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 远端拉取可用模型：先试 OpenAI 兼容的 /models，再试 Anthropic 兼容前缀。
 * 都失败时抛出错误，由调用方退回缓存或内置列表。
 */
export const fetchRemoteModels = async (apiKey: string): Promise<ModelOption[]> => {
  if (!apiKey.trim()) {
    throw new Error('missing api key')
  }
  const attempts: Array<() => Promise<unknown>> = [
    () =>
      requestJson(`${API_ORIGIN}/models`, {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      }),
    () =>
      requestJson(`${API_ORIGIN}/anthropic/v1/models`, {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
      }),
  ]
  let lastError: unknown = new Error('no endpoint')
  for (const attempt of attempts) {
    try {
      const models = parseModels(await attempt())
      if (models.length > 0) {
        writeCache(models)
        return models
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
