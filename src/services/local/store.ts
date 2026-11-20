import { create } from 'zustand'
import { translate } from '../../i18n/index.js'
import {
  buildWebllmCatalog,
  findLocalModel,
  isMlcModel,
  isWebllmModel,
  mlcModelId,
  type LocalModelInfo,
  webllmModelId,
} from './catalog.js'
import { setModel, useSettings } from '../settings.js'
import type { ChatModel } from '../api/types.js'
import { listMlcModels } from './mlcApi.js'

/**
 * 本地模型设置与运行状态。
 *
 * 配置持久化在 localStorage（`chat-demo:local-*`），选中值仍写进 `settings.model`，
 * 这样聊天栏、会话统计、消息气泡都能像云端模型一样读取当前模型。
 * 运行状态（加载进度、下载状态、导入导出进度）只放内存，刷新页面后由引擎重新探测。
 */

export type WebllmCacheBackend = 'cache' | 'indexeddb'
export type LocalEngineStatus = 'idle' | 'loading' | 'ready' | 'error'
export type TransferKind = 'export' | 'import'

/** 引擎能力探测结果：WebGPU 不可用时给出原因，UI 里显示替代方案 */
export type GpuProbe = {
  supported: boolean
  /** 适配器厂商 / 架构等信息，来自 GPUAdapterInfo（部分浏览器不给） */
  vendor?: string
  architecture?: string
  description?: string
  /** 不支持时的原因 */
  reason?: string
}

/** MLC-LLM API 的模型条目（GET /v1/models） */
export type MlcModelInfo = {
  /** 服务端返回的 id，选择值为 `mlc/<id>` */
  id: string
  label: string
}

type LocalSettings = {
  cacheBackend: WebllmCacheBackend
  /** null 表示跟随模型推荐值 */
  contextWindow: number | null
  temperature: number
  topP: number
  maxTokens: number
  presencePenalty: number
  frequencyPenalty: number
  /** 远端 MLC-LLM 服务地址，如 http://127.0.0.1:8000 */
  mlcEndpoint: string
  /** 打开页面时自动加载上次用过的浏览器模型 */
  autoLoad: boolean
}

export type LocalModelState = LocalSettings & {
  status: LocalEngineStatus
  /** 加载阶段文案（下载 / 编译 wasm / 初始化 GPU） */
  progressText: string
  /** 0–1 */
  progress: number
  error: string | null
  /** 当前已加载进显存的 model_id */
  loadedModelId: string | null
  /** 已下载到浏览器的模型：model_id → true */
  downloaded: Record<string, boolean>
  /** 正在下载/加载的 model_id，同一时间只允许一个 */
  downloadingId: string | null
  gpu: GpuProbe | null
  gpuChecking: boolean
  /** 导入导出进度，null 表示空闲 */
  transfer: {
    kind: TransferKind
    modelId: string
    /** 0–1，未知总量时为 null */
    percent: number | null
    text: string
  } | null
  mlcModels: MlcModelInfo[]
  mlcLoading: boolean
  mlcError: string | null
  /** 目录是否已经和当前缓存的下载状态同步过 */
  catalogSynced: boolean
}

const KEYS = {
  cacheBackend: 'chat-demo:local-cache-backend',
  contextWindow: 'chat-demo:local-context-window',
  temperature: 'chat-demo:local-temperature',
  topP: 'chat-demo:local-top-p',
  maxTokens: 'chat-demo:local-max-tokens',
  presencePenalty: 'chat-demo:local-presence-penalty',
  frequencyPenalty: 'chat-demo:local-frequency-penalty',
  mlcEndpoint: 'chat-demo:local-mlc-endpoint',
  autoLoad: 'chat-demo:local-auto-load',
} as const

const read = (key: string): string | null => {
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
    // 隐私模式下写入失败不影响本次会话
  }
}

const readNumber = (key: string, fallback: number, min: number, max: number): number => {
  const raw = read(key)
  if (raw === null) {
    return fallback
  }
  const value = Number(raw)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

const initialContextWindow = (): number | null => {
  const raw = read(KEYS.contextWindow)
  if (raw === null || raw === 'auto') {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) && value >= 512 ? Math.round(value) : null
}

export const LOCAL_CONTEXT_WINDOWS = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072]

const DEFAULT_MLC_ENDPOINT = 'http://127.0.0.1:8000'

const initialEndpoint = (): string => {
  const raw = read(KEYS.mlcEndpoint)
  return raw === null ? DEFAULT_MLC_ENDPOINT : raw.trim()
}

const initialSettings = (): LocalSettings => ({
  cacheBackend: read(KEYS.cacheBackend) === 'indexeddb' ? 'indexeddb' : 'cache',
  contextWindow: initialContextWindow(),
  // 默认值沿用 WebLLM 各模型推荐配置的常见组合
  temperature: readNumber(KEYS.temperature, 0.7, 0, 2),
  topP: readNumber(KEYS.topP, 0.95, 0, 1),
  maxTokens: Math.round(readNumber(KEYS.maxTokens, 2048, 1, 131072)),
  presencePenalty: readNumber(KEYS.presencePenalty, 0, -2, 2),
  frequencyPenalty: readNumber(KEYS.frequencyPenalty, 0, -2, 2),
  mlcEndpoint: initialEndpoint(),
  autoLoad: read(KEYS.autoLoad) === 'true',
})

export const useLocalModels = create<LocalModelState>(() => ({
  ...initialSettings(),
  status: 'idle',
  progressText: '',
  progress: 0,
  error: null,
  loadedModelId: null,
  downloaded: {},
  downloadingId: null,
  gpu: null,
  gpuChecking: false,
  transfer: null,
  mlcModels: [],
  mlcLoading: false,
  mlcError: null,
  catalogSynced: false,
}))

/** 合并式更新本地模型设置并落盘；数值字段在这里统一做范围校验 */
export const setLocalSettings = (patch: Partial<LocalSettings>) => {
  const current = useLocalModels.getState()
  const next: LocalSettings = { ...current, ...patch }
  next.temperature = Math.min(2, Math.max(0, next.temperature))
  next.topP = Math.min(1, Math.max(0, next.topP))
  next.maxTokens = Math.round(Math.min(131072, Math.max(1, next.maxTokens)))
  next.presencePenalty = Math.min(2, Math.max(-2, next.presencePenalty))
  next.frequencyPenalty = Math.min(2, Math.max(-2, next.frequencyPenalty))
  next.cacheBackend = next.cacheBackend === 'indexeddb' ? 'indexeddb' : 'cache'
  next.mlcEndpoint = next.mlcEndpoint.trim()
  write(KEYS.cacheBackend, next.cacheBackend)
  write(KEYS.contextWindow, next.contextWindow === null ? 'auto' : String(next.contextWindow))
  write(KEYS.temperature, String(next.temperature))
  write(KEYS.topP, String(next.topP))
  write(KEYS.maxTokens, String(next.maxTokens))
  write(KEYS.presencePenalty, String(next.presencePenalty))
  write(KEYS.frequencyPenalty, String(next.frequencyPenalty))
  write(KEYS.mlcEndpoint, next.mlcEndpoint)
  write(KEYS.autoLoad, String(next.autoLoad))
  useLocalModels.setState({
    cacheBackend: next.cacheBackend,
    contextWindow: next.contextWindow,
    temperature: next.temperature,
    topP: next.topP,
    maxTokens: next.maxTokens,
    presencePenalty: next.presencePenalty,
    frequencyPenalty: next.frequencyPenalty,
    mlcEndpoint: next.mlcEndpoint,
    autoLoad: next.autoLoad,
  })
}

/**
 * 恢复默认设置时一并重置本地模型偏好：缓存后端、上下文窗口、采样参数、
 * MLC 地址与自动加载全部回到默认值；已下载的权重留在浏览器缓存里，不删除。
 */
export const resetLocalModelSettings = () => {
  for (const key of Object.values(KEYS)) {
    write(key, null)
  }
  useLocalModels.setState({
    ...initialSettings(),
    status: 'idle',
    progressText: '',
    progress: 0,
    error: null,
    loadedModelId: null,
    downloadingId: null,
    transfer: null,
    mlcModels: [],
    mlcLoading: false,
    mlcError: null,
    catalogSynced: false,
  })
}

/** 选中模型时套用官方推荐采样参数，避免小模型被默认温度带偏 */
export const applyRecommendedParams = (info: LocalModelInfo) => {
  setLocalSettings({
    temperature: info.temperature,
    topP: info.topP,
    presencePenalty: info.presencePenalty,
    frequencyPenalty: info.frequencyPenalty,
  })
}

/** 某个模型实际使用的上下文窗口：设置里选「自动」时回到官方推荐值 */
export const contextWindowForModel = (modelId: string): number => {
  const state = useLocalModels.getState()
  return state.contextWindow ?? findLocalModel(modelId)?.contextWindow ?? 4096
}

/** 目录入口：给 UI 用，按需构建并缓存 */
export const localCatalog = (): LocalModelInfo[] => buildWebllmCatalog()

/** 选中本地模型：写 settings.model，并按前缀同步到本地模型状态 */
export const selectLocalModel = (selection: string) => {
  if (isWebllmModel(selection)) {
    const info = findLocalModel(webllmModelId(selection))
    if (info) {
      applyRecommendedParams(info)
    }
  } else if (isMlcModel(selection)) {
    // MLC-LLM API 的采样参数交给现有设置里的温度 / top_p，只切换端点模型
  } else {
    return
  }
  setModel(selection as ChatModel)
}

/** 当前选中的浏览器模型信息；选中值不是本地模型时返回 null */
export const selectedWebllmInfo = (): LocalModelInfo | null => {
  const model = useSettings.getState().model
  if (!isWebllmModel(model)) {
    return null
  }
  return findLocalModel(webllmModelId(model)) ?? null
}

/** 拉取 MLC-LLM API 的模型列表；失败时把错误写进状态，由 UI 提示 */
export const refreshMlcModels = async (): Promise<MlcModelInfo[]> => {
  const endpoint = useLocalModels.getState().mlcEndpoint
  if (!endpoint.trim()) {
    useLocalModels.setState({ mlcError: translate('localModelMlcNoEndpoint'), mlcModels: [] })
    return []
  }
  useLocalModels.setState({ mlcLoading: true, mlcError: null })
  try {
    const models = await listMlcModels(endpoint)
    useLocalModels.setState({ mlcModels: models, mlcLoading: false })
    return models
  } catch (error) {
    useLocalModels.setState({
      mlcLoading: false,
      mlcError: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/** 当前选中的 MLC-LLM API 模型 id；不适用时返回 null */
export const selectedMlcModelId = (): string | null => {
  const model = useSettings.getState().model
  return isMlcModel(model) ? mlcModelId(model) : null
}
