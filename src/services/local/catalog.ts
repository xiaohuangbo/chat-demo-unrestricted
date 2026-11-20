import { ModelType, prebuiltAppConfig, type ModelRecord } from '@mlc-ai/web-llm'
import { MODEL_BASES, type LocalModelBase, type LocalModelFamily } from './catalogData.js'

/**
 * 本地模型目录：WebLLM 预置模型（浏览器 WebGPU 运行）+ MLC-LLM API 模型。
 *
 * 选中值直接写进现有的 `settings.model`，用前缀区分来源：
 * - `webllm/<model_id>`：浏览器内 WebLLM，权重下载到 Cache Storage / IndexedDB
 * - `mlc/<model_id>`：远端 MLC-LLM REST 服务（/v1/chat/completions）
 * 其余值（deepseek-flash 等）仍走 DeepSeek 云端接口。
 */

/** 浏览器本地模型的前缀 */
export const WEBLLM_PREFIX = 'webllm/'
/** MLC-LLM API 模型的前缀 */
export const MLC_PREFIX = 'mlc/'

export const webllmSelection = (modelId: string): string => `${WEBLLM_PREFIX}${modelId}`
export const mlcSelection = (modelId: string): string => `${MLC_PREFIX}${modelId}`

export const isWebllmModel = (model: string): boolean => model.startsWith(WEBLLM_PREFIX)
export const isMlcModel = (model: string): boolean => model.startsWith(MLC_PREFIX)
export const isLocalModel = (model: string): boolean => isWebllmModel(model) || isMlcModel(model)

export const webllmModelId = (model: string): string => model.slice(WEBLLM_PREFIX.length)
export const mlcModelId = (model: string): string => model.slice(MLC_PREFIX.length)

/** 模型家族的分组顺序：常用的小参数模型在前，方便手机端先看到能跑动的 */
export const FAMILY_ORDER: LocalModelFamily[] = [
  'llama',
  'qwen',
  'gemma',
  'phi',
  'mistral',
  'deepseek',
  'smollm',
  'stablelm',
  'redpajama',
  'wizardmath',
  'olmo',
  'other',
]

export const FAMILY_LABELS: Record<LocalModelFamily, string> = {
  llama: 'Llama',
  qwen: 'Qwen',
  gemma: 'Gemma',
  phi: 'Phi',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  smollm: 'SmolLM',
  stablelm: 'StableLM',
  redpajama: 'RedPajama',
  wizardmath: 'WizardMath',
  olmo: 'OLMo',
  other: 'Other',
}

/** 目录里的一条模型：采样推荐值、显存需求与缓存尺寸提示都来自 WebLLM 的模型记录 */
export type LocalModelInfo = {
  /** WebLLM 的 model_id，同时也是 `prebuiltAppConfig` 里的键 */
  id: string
  /** 家族名（Llama / Qwen …），列表分组用 */
  family: LocalModelFamily
  /** 家族显示名 */
  familyLabel: string
  /** 具体型号，去掉量化后缀后的可读名称 */
  name: string
  provider: string
  /** 参数规模，如 1B / 8B */
  size?: string
  /** 量化方式，如 q4f16_1 */
  quantization?: string
  /** 推荐上下文窗口 */
  contextWindow: number
  /** 官方估算的显存占用（MB），没有时按参数规模粗估 */
  vramMB?: number
  /** 是否可在低资源设备（手机）上运行 */
  lowResource: boolean
  /** 视觉模型：WebLLM 支持带图输入，本项目只发文本 */
  vision: boolean
  /** 推荐采样参数 */
  temperature: number
  topP: number
  presencePenalty: number
  frequencyPenalty: number
}

/** 从 model_id 里取参数规模：Llama-3.2-1B-… → 1B */
export const modelSize = (modelId: string): string | undefined =>
  modelId.match(/-(E?\d+(\.\d+)?[BK])-?/i)?.[1]

/** 从 model_id 里取量化方式：…-q4f16_1-MLC → q4f16_1 */
export const modelQuantization = (modelId: string): string | undefined =>
  modelId.match(/-(q[0-9]f[0-9]+(?:_[0-9])?)-/)?.[1]

/** 去掉 -q4f16_1-MLC(-1k) 后缀，得到可读型号 */
const prettyModelName = (modelId: string): string =>
  modelId.replace(/-q[0-9]f[0-9]+(?:_[0-9])?-MLC(-1k)?$/, '').replace(/-MLC(-1k)?$/, '')

/** 预置目录里没有的模型：按 id 前缀推断家族与厂商，保证列表分组稳定 */
const inferFamily = (modelId: string): LocalModelFamily => {
  const id = modelId.toLowerCase()
  if (id.startsWith('deepseek')) {
    return 'deepseek'
  }
  if (id.startsWith('qwen')) {
    return 'qwen'
  }
  if (id.startsWith('gemma')) {
    return 'gemma'
  }
  if (id.startsWith('phi')) {
    return 'phi'
  }
  if (id.startsWith('ministral') || id.startsWith('mistral')) {
    return 'mistral'
  }
  if (id.startsWith('hermes') || id.startsWith('llama') || id.startsWith('tinyllama')) {
    return 'llama'
  }
  if (id.startsWith('olmo')) {
    return 'olmo'
  }
  if (id.startsWith('smol')) {
    return 'smollm'
  }
  if (id.startsWith('stablelm')) {
    return 'stablelm'
  }
  if (id.startsWith('redpajama')) {
    return 'redpajama'
  }
  if (id.startsWith('wizard')) {
    return 'wizardmath'
  }
  return 'other'
}

const inferProvider = (modelId: string): string => {
  const id = modelId.toLowerCase()
  if (id.startsWith('deepseek')) {
    return 'DeepSeek'
  }
  if (id.startsWith('qwen')) {
    return 'Alibaba'
  }
  if (id.startsWith('gemma')) {
    return 'Google'
  }
  if (id.startsWith('phi')) {
    return 'Microsoft'
  }
  if (id.startsWith('ministral') || id.startsWith('mistral')) {
    return 'Mistral'
  }
  if (id.startsWith('hermes')) {
    return 'NousResearch'
  }
  if (id.startsWith('llama') || id.startsWith('tinyllama')) {
    return 'Meta'
  }
  if (id.startsWith('olmo')) {
    return 'AllenAI'
  }
  if (id.startsWith('smol')) {
    return 'HuggingFace'
  }
  if (id.startsWith('stablelm')) {
    return 'Stability AI'
  }
  if (id.startsWith('redpajama')) {
    return 'Together'
  }
  return 'Community'
}

const BASE_BY_NAME = new Map<string, LocalModelBase>(MODEL_BASES.map((item) => [item.name, item]))

const DEFAULT_CONTEXT_WINDOW = 4096
const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_TOP_P = 0.95

const toInfo = (record: ModelRecord): LocalModelInfo => {
  const base = BASE_BY_NAME.get(record.model_id)
  const family = base?.family ?? inferFamily(record.model_id)
  const recommended = base?.recommended_config
  return {
    id: record.model_id,
    family,
    familyLabel: FAMILY_LABELS[family],
    name: prettyModelName(record.model_id),
    provider: base?.provider ?? inferProvider(record.model_id),
    size: modelSize(record.model_id),
    quantization: modelQuantization(record.model_id),
    contextWindow:
      recommended?.context_window_size ??
      record.overrides?.context_window_size ??
      DEFAULT_CONTEXT_WINDOW,
    vramMB: record.vram_required_MB,
    lowResource: record.low_resource_required === true,
    vision: record.model_type === ModelType.VLM,
    temperature: recommended?.temperature ?? DEFAULT_TEMPERATURE,
    topP: recommended?.top_p ?? DEFAULT_TOP_P,
    presencePenalty: recommended?.presence_penalty ?? 0,
    frequencyPenalty: recommended?.frequency_penalty ?? 0,
  }
}

/**
 * 构建 WebLLM 目录：以当前安装的 web-llm 版本为准（模型库与 npm 版本绑定），
 * 只保留聊天模型，embedding 类模型不参与对话。
 */
let catalogCache: LocalModelInfo[] | null = null

export const buildWebllmCatalog = (): LocalModelInfo[] => {
  if (catalogCache) {
    return catalogCache
  }
  const models = prebuiltAppConfig.model_list
    .filter((record: ModelRecord) => record.model_type !== ModelType.embedding)
    .map((record: ModelRecord) => toInfo(record))
  const sorted = models.sort((a: LocalModelInfo, b: LocalModelInfo) => {
    const familyDiff = FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)
    return familyDiff !== 0 ? familyDiff : a.name.localeCompare(b.name)
  })
  catalogCache = sorted
  return sorted
}

/** 与 WebLLM 的 cleanModelUrl 等价：补齐斜杠与 resolve/main/，缓存键都以它拼接 */
export const modelBaseUrl = (model: string): string => {
  let url = model.endsWith('/') ? model : `${model}/`
  if (!/.+\/resolve\/.+\//.test(url)) {
    url += 'resolve/main/'
  }
  return new URL(url).href
}

/** 默认选中的浏览器模型：1B 级别、低资源可用，先保证能跑起来 */
const PREFERRED_DEFAULT = 'Llama-3.2-1B-Instruct-q4f32_1-MLC'

export const defaultWebllmModelId = (catalog: LocalModelInfo[]): string =>
  catalog.find((item) => item.id === PREFERRED_DEFAULT)?.id ??
  catalog.find((item) => item.lowResource)?.id ??
  catalog[0]?.id ??
  ''

export const findWebllmRecord = (modelId: string): ModelRecord | undefined =>
  prebuiltAppConfig.model_list.find((record: ModelRecord) => record.model_id === modelId)

/** 按 id 取目录条目，失败时返回 undefined（模型可能在升级后被移除） */
export const findLocalModel = (modelId: string): LocalModelInfo | undefined =>
  buildWebllmCatalog().find((item) => item.id === modelId)
