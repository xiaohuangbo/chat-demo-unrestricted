import {
  deleteModelAllInfoInCache,
  hasModelInCache,
  prebuiltAppConfig,
  WebWorkerMLCEngine,
  type AppConfig,
  type InitProgressReport,
  type LogLevel,
} from '@mlc-ai/web-llm'
import { findWebllmRecord, modelBaseUrl, webllmModelId } from './catalog.js'
import { contextWindowForModel, localCatalog, useLocalModels, type GpuProbe } from './store.js'
import { useSettings } from '../settings.js'
import { translate } from '../../i18n/index.js'

/**
 * 浏览器内 WebLLM 引擎：单例 Web Worker + 主线程代理。
 *
 * - 权重下载、wasm 编译、GPU 初始化都在 Worker 里完成，主线程只收进度文案；
 * - 同一时间只保留一个模型在显存里，切换模型时先卸载再加载；
 * - 生成中断用 `interruptGenerate()`，不需要重建 Worker。
 */

/** 聊天请求需要的消息形态（OpenAI 兼容） */
export type LocalChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type LocalGenerateParams = {
  messages: LocalChatMessage[]
  temperature?: number
  topP?: number
  maxTokens?: number
  presencePenalty?: number
  frequencyPenalty?: number
  /** Qwen3 系列：是否开启  thinking 模式 */
  enableThinking?: boolean
  signal?: AbortSignal
  onDelta?: (chunk: string) => void
}

export type LocalGenerateResult = {
  content: string
  finishReason?: string
  usage?: { promptTokens: number; completionTokens: number }
}

/** WebLLM 生成流的分片（OpenAI 协议子集，避免依赖包的深层类型导出） */
type StreamedChunk = {
  choices: Array<{
    delta?: { content?: string | null } | null
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

export class LocalModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalModelError'
  }
}

/** 当前 Worker 实例；页面卸载或后端切换时销毁 */
let engine: WebWorkerMLCEngine | null = null
/** 已加载的模型，避免每次对话重复 reload */
let loadedModelId: string | null = null
/** 加载时使用的上下文窗口，和设置不一致时需要重新加载 */
let loadedContextWindow = 0
/** 正在进行的加载，避免并发 reload */
let loading: Promise<void> | null = null
let loadingModelId: string | null = null
/** 连续生成请求串行执行，和上游 WebLLM 的用法保持一致 */
let pendingChat: Promise<unknown> = Promise.resolve()

const buildAppConfig = (cacheBackend: 'cache' | 'indexeddb'): AppConfig => ({
  ...prebuiltAppConfig,
  cacheBackend,
})

export const localAppConfig = (): AppConfig =>
  buildAppConfig(useLocalModels.getState().cacheBackend)

const ensureEngine = (): WebWorkerMLCEngine => {
  if (engine) {
    return engine
  }
  if (typeof Worker === 'undefined') {
    throw new LocalModelError(translate('localModelWorkerUnsupported'))
  }
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  engine = new WebWorkerMLCEngine(worker, {
    appConfig: localAppConfig(),
    logLevel: 'WARN' as LogLevel,
  })
  return engine
}

/** 探测 WebGPU：不支持的浏览器（Safari 旧版、部分 WebView）直接给替代方案 */
export const probeGpu = async (): Promise<GpuProbe> => {
  useLocalModels.setState({ gpuChecking: true })
  try {
    const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu
    if (!gpu) {
      const probe: GpuProbe = { supported: false, reason: translate('localModelGpuMissing') }
      useLocalModels.setState({ gpu: probe, gpuChecking: false })
      return probe
    }
    const adapter = await gpu.requestAdapter()
    if (!adapter) {
      const probe: GpuProbe = { supported: false, reason: translate('localModelGpuNoAdapter') }
      useLocalModels.setState({ gpu: probe, gpuChecking: false })
      return probe
    }
    const info = adapter.info
    const probe: GpuProbe = {
      supported: true,
      vendor: info?.vendor || undefined,
      architecture: info?.architecture || undefined,
      description: info?.description || undefined,
    }
    useLocalModels.setState({ gpu: probe, gpuChecking: false })
    return probe
  } catch (error) {
    const probe: GpuProbe = {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
    }
    useLocalModels.setState({ gpu: probe, gpuChecking: false })
    return probe
  }
}

type Gpu = {
  requestAdapter(): Promise<{
    info?: { vendor?: string; architecture?: string; description?: string }
  } | null>
}

const reportProgress = (report: InitProgressReport) => {
  useLocalModels.setState({
    progress: Math.max(0, Math.min(1, report.progress)),
    progressText: report.text,
  })
}

/** 加载（必要时先下载）模型：进度写进本地模型状态，成功后标记已下载 */
export const loadModel = async (modelId: string): Promise<void> => {
  if (loading && loadingModelId === modelId) {
    return loading
  }
  const record = findWebllmRecord(modelId)
  if (!record) {
    throw new LocalModelError(translate('localModelNotFound', { model: modelId }))
  }
  const contextWindow = contextWindowForModel(modelId)
  useLocalModels.setState({
    status: 'loading',
    progress: 0,
    progressText: translate('localModelPreparing'),
    error: null,
    downloadingId: modelId,
  })
  loadingModelId = modelId
  const task = (async () => {
    const instance = ensureEngine()
    instance.setAppConfig(localAppConfig())
    instance.setInitProgressCallback(reportProgress)
    try {
      await instance.reload(modelId, { context_window_size: contextWindow })
      loadedModelId = modelId
      loadedContextWindow = contextWindow
      useLocalModels.setState((current) => ({
        status: 'ready',
        progress: 1,
        progressText: translate('localModelReadyText'),
        loadedModelId: modelId,
        downloadingId: null,
        error: null,
        downloaded: { ...current.downloaded, [modelId]: true },
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      useLocalModels.setState({
        status: 'error',
        downloadingId: null,
        error: translate('localModelLoadFailed', { error: message }),
        progressText: '',
      })
      throw error
    } finally {
      loading = null
      loadingModelId = null
    }
  })()
  loading = task
  return task
}

/** 切换模型：已经在显存里的直接复用，否则重新加载 */
export const ensureModelLoaded = async (modelId: string): Promise<void> => {
  const contextWindow = contextWindowForModel(modelId)
  if (loadedModelId === modelId && loadedContextWindow === contextWindow) {
    if (useLocalModels.getState().status !== 'ready') {
      useLocalModels.setState({ status: 'ready', loadedModelId: modelId })
    }
    return
  }
  await loadModel(modelId)
}

/** 卸载显存里的模型，权重缓存保留，下次加载不用重新下载 */
export const unloadModel = async (): Promise<void> => {
  if (!engine) {
    loadedModelId = null
    return
  }
  try {
    await engine.unload()
  } catch {
    // Worker 已经被回收时 unload 会失败，忽略即可
  }
  loadedModelId = null
  loadedContextWindow = 0
  useLocalModels.setState({
    status: 'idle',
    loadedModelId: null,
    progress: 0,
    progressText: '',
  })
}

/** 中断当前生成；加载阶段直接卸载以释放显存 */
export const interruptGeneration = async (): Promise<void> => {
  if (!engine) {
    return
  }
  if (useLocalModels.getState().status === 'loading') {
    await unloadModel()
    return
  }
  try {
    engine.interruptGenerate()
  } catch {
    // 没有进行中的生成时调用会被忽略
  }
}

/** 流式生成：逐块回调 onDelta，返回完整文本与 usage（浏览器模型的计费为 0） */
export const generate = async (params: LocalGenerateParams): Promise<LocalGenerateResult> => {
  if (params.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  const modelId = webllmModelId(useSettings.getState().model)
  await ensureModelLoaded(modelId)
  if (params.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  const instance = ensureEngine()
  const run = pendingChat.then(async () => {
    const stream = await instance.chat.completions.create({
      stream: true,
      messages: params.messages,
      temperature: params.temperature,
      top_p: params.topP,
      max_tokens: params.maxTokens,
      presence_penalty: params.presencePenalty,
      frequency_penalty: params.frequencyPenalty,
      ...(params.enableThinking ? { enable_thinking: true } : {}),
      stream_options: { include_usage: true },
    })
    let content = ''
    let finishReason: string | undefined
    let usage: StreamedChunk['usage']
    for await (const chunk of stream as AsyncIterable<StreamedChunk>) {
      if (params.signal?.aborted) {
        await interruptGeneration()
        break
      }
      const delta = chunk.choices[0]?.delta
      if (delta?.content) {
        content += delta.content
        params.onDelta?.(delta.content)
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason
      }
      if (chunk.usage) {
        usage = chunk.usage
      }
    }
    return {
      content,
      finishReason,
      usage: usage
        ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 }
        : undefined,
    }
  })
  pendingChat = run.catch(() => {})
  return run
}

/**
 * 查询模型权重是否已在浏览器缓存里。
 *
 * 不能用 WebLLM 的 `hasModelInCache` 做列表探测：它会对每个模型 `cache.add()` 一次
 * tensor-cache.json，打开设置页就会发起上百个网络请求（离线时还会抛 NetworkError）。
 * 这里直接枚举 Cache Storage 的 key，先看 tensor-cache.json，再按 dataPath 校验分片。
 * IndexedDB 后端拿不到 key 列表，才退回官方实现。
 */
export const checkDownloaded = async (modelId: string): Promise<boolean> => {
  const record = findWebllmRecord(modelId)
  if (!record) {
    return false
  }
  const backend = useLocalModels.getState().cacheBackend
  if (backend === 'cache' && typeof caches !== 'undefined') {
    try {
      const cache = await caches.open('webllm/model')
      const base = modelBaseUrl(record.model)
      const keys = new Set((await cache.keys()).map((request) => request.url))
      const manifestUrl = new URL('tensor-cache.json', base).href
      if (!keys.has(manifestUrl)) {
        return false
      }
      const response = await cache.match(manifestUrl)
      if (!response) {
        return false
      }
      const manifest = (await response.json()) as { records?: Array<{ dataPath?: string }> }
      const shards = (manifest.records ?? [])
        .map((item) => item.dataPath)
        .filter((path): path is string => typeof path === 'string' && path !== '')
      return shards.length > 0 && shards.every((path) => keys.has(new URL(path, base).href))
    } catch {
      return false
    }
  }
  try {
    return await hasModelInCache(modelId, localAppConfig())
  } catch {
    return false
  }
}

/** 刷新一批模型的下载状态，写入 store；limit 控制并发，避免一次打开太多 Cache */
export const refreshDownloaded = async (modelIds?: string[]): Promise<void> => {
  const ids = modelIds ?? localCatalog().map((item) => item.id)
  const downloaded: Record<string, boolean> = { ...useLocalModels.getState().downloaded }
  const queue = [...ids]
  const worker = async () => {
    while (queue.length > 0) {
      const id = queue.shift()
      if (!id) {
        return
      }
      downloaded[id] = await checkDownloaded(id)
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  useLocalModels.setState({ downloaded, catalogSynced: true })
}

/** 删除模型的所有缓存（权重、tokenizer、配置、wasm） */
export const deleteModel = async (modelId: string): Promise<void> => {
  if (loadedModelId === modelId) {
    await unloadModel()
  }
  try {
    await deleteModelAllInfoInCache(modelId, localAppConfig())
  } catch (error) {
    throw new LocalModelError(
      translate('localModelDeleteFailed', {
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }
  useLocalModels.setState((current) => ({
    downloaded: Object.fromEntries(
      Object.entries(current.downloaded).filter(([id]) => id !== modelId)
    ),
  }))
}

/** 释放 Worker：只在页面卸载或切换缓存后端时调用 */
export const disposeEngine = async (): Promise<void> => {
  if (!engine) {
    return
  }
  const instance = engine
  engine = null
  loadedModelId = null
  loadedContextWindow = 0
  try {
    await instance.unload()
  } catch {
    // 忽略卸载失败
  }
  // unload 只释放显存，Worker 线程要显式结束，否则切换缓存后端会残留一个推理线程
  try {
    instance.worker.terminate()
  } catch {
    // Worker 已被回收时忽略
  }
  useLocalModels.setState({ status: 'idle', loadedModelId: null, progress: 0, progressText: '' })
}
