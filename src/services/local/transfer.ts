import { findWebllmRecord, modelBaseUrl } from './catalog.js'
import { checkDownloaded, localAppConfig } from './engine.js'
import { useLocalModels } from './store.js'
import { translate } from '../../i18n/index.js'

/**
 * 已下载模型的导入 / 导出。
 *
 * WebLLM 把权重、tokenizer、mlc-chat-config.json 与 wasm 分别放在 Cache Storage 的
 * `webllm/model`、`webllm/config`、`webllm/wasm` 三个缓存里，键就是原始下载地址。
 * 这里自定义一个可流式读写的容器 `.mlcmodel`：
 *
 *   [文件 0 字节][文件 1 字节]…[footer JSON][footer 长度 uint32 LE]
 *
 * footer 记录每个文件的地址、所属缓存与偏移，导入时按 Blob.slice 逐段写回缓存，
 * 全程不需要把几 GB 的权重读进内存。浏览器不支持流式落盘时退回 Blob 下载。
 */

export const BUNDLE_FORMAT = 'mlc-model-bundle'
export const BUNDLE_VERSION = 1
export const BUNDLE_EXTENSION = '.mlcmodel'

/** 三个缓存作用域与 WebLLM 内部的命名保持一致 */
const SCOPES = ['webllm/model', 'webllm/config', 'webllm/wasm'] as const
type Scope = (typeof SCOPES)[number]

type BundleEntry = {
  url: string
  scope: Scope
  offset: number
  size: number
  type?: string
}

type BundleFooter = {
  format: typeof BUNDLE_FORMAT
  version: number
  engine: 'webllm'
  modelId: string
  modelBase: string
  modelLib: string
  createdAt: number
  appVersion?: string
  entries: BundleEntry[]
}

export type ExportResult = {
  modelId: string
  fileName: string
  size: number
  /** 已经通过系统保存对话框落盘 */
  saved: boolean
  /** 需要在页面里触发下载的 Blob（不支持保存对话框时） */
  blob?: Blob
}

export type ImportResult = {
  modelId: string
  fileCount: number
  size: number
}

const ensureCacheApi = () => {
  if (typeof caches === 'undefined') {
    throw new Error(translate('localModelCacheUnavailable'))
  }
}

/** 列出某个模型在三个缓存里的全部文件 */
const collectFiles = async (modelId: string): Promise<BundleEntry[]> => {
  const record = findWebllmRecord(modelId)
  if (!record) {
    throw new Error(translate('localModelNotFound', { model: modelId }))
  }
  const base = modelBaseUrl(record.model)
  const entries: BundleEntry[] = []
  for (const scope of SCOPES) {
    const cache = await caches.open(scope)
    const requests = await cache.keys()
    for (const request of requests) {
      const url = request.url
      const matched = scope === 'webllm/wasm' ? url === record.model_lib : url.startsWith(base)
      if (!matched) {
        continue
      }
      const response = await cache.match(request)
      entries.push({
        url,
        scope,
        offset: 0,
        size: Number(response?.headers.get('Content-Length') ?? 0),
        type: response?.headers.get('Content-Type') ?? undefined,
      })
    }
  }
  entries.sort((a, b) =>
    a.scope === b.scope
      ? a.url.localeCompare(b.url)
      : SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope)
  )
  return entries
}

/** 保存对话框（File System Access API）只在 Chromium 桌面版可用 */
type WritableLike = {
  write(data: Blob | Uint8Array | ArrayBuffer): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

type SavePicker = (options: {
  suggestedName?: string
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}) => Promise<{ createWritable(): Promise<WritableLike> }>

const savePicker = (): SavePicker | undefined =>
  (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker

const setTransfer = (
  kind: 'export' | 'import',
  modelId: string,
  percent: number | null,
  text: string
) => useLocalModels.setState({ transfer: { kind, modelId, percent, text } })

const clearTransfer = () => useLocalModels.setState({ transfer: null })

/** 导出模型：优先流式写盘，无法写盘时退回内存 Blob */
export const exportModel = async (modelId: string): Promise<ExportResult> => {
  ensureCacheApi()
  const downloaded = await checkDownloaded(modelId)
  if (!downloaded) {
    throw new Error(translate('localModelNotDownloaded'))
  }
  const record = findWebllmRecord(modelId)
  if (!record) {
    throw new Error(translate('localModelNotFound', { model: modelId }))
  }
  const files = await collectFiles(modelId)
  if (files.length === 0) {
    throw new Error(translate('localModelExportEmpty'))
  }
  const fileName = `${modelId.replace(/[^\w.-]+/g, '_')}${BUNDLE_EXTENSION}`
  setTransfer('export', modelId, 0, translate('localModelExportPreparing'))
  const picker = savePicker()
  let writable: WritableLike | null = null
  const chunks: BlobPart[] = []
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [
          {
            description: 'MLC model bundle',
            accept: { 'application/octet-stream': [BUNDLE_EXTENSION] },
          },
        ],
      })
      writable = await handle.createWritable()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        clearTransfer()
        throw error
      }
      // 没有用户手势、权限被拒绝：退回内存 Blob
      writable = null
    }
  }
  const write = async (data: Blob | Uint8Array) => {
    if (writable) {
      await writable.write(data)
    } else {
      chunks.push(data instanceof Blob ? data : new Uint8Array(data))
    }
  }
  const offsetOf = new Map<string, number>()
  let offset = 0
  try {
    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index]
      const cache = await caches.open(entry.scope)
      const response = await cache.match(new Request(entry.url))
      if (!response || !response.body) {
        continue
      }
      offsetOf.set(entry.url, offset)
      const reader = response.body.getReader()
      let size = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }
        if (!value) {
          continue
        }
        size += value.byteLength
        await write(value)
      }
      offset += size
      entry.offset = offsetOf.get(entry.url) ?? 0
      entry.size = size
      setTransfer(
        'export',
        modelId,
        index / files.length,
        translate('localModelExportProgress', { done: index + 1, total: files.length })
      )
    }
    const footer: BundleFooter = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      engine: 'webllm',
      modelId,
      modelBase: modelBaseUrl(record.model),
      modelLib: record.model_lib,
      createdAt: Date.now(),
      entries: files.filter((entry) => entry.size > 0),
    }
    const footerBytes = new TextEncoder().encode(JSON.stringify(footer))
    const lengthBytes = new Uint8Array(4)
    new DataView(lengthBytes.buffer).setUint32(0, footerBytes.byteLength, true)
    await write(footerBytes)
    await write(lengthBytes)
    offset += footerBytes.byteLength + 4
    if (writable) {
      await writable.close()
      setTransfer('export', modelId, 1, translate('localModelExportDone'))
      setTimeout(clearTransfer, 800)
      return { modelId, fileName, size: offset, saved: true }
    }
    const blob = new Blob(chunks, { type: 'application/octet-stream' })
    setTransfer('export', modelId, 1, translate('localModelExportDone'))
    setTimeout(clearTransfer, 800)
    return { modelId, fileName, size: blob.size, saved: false, blob }
  } catch (error) {
    if (writable?.abort) {
      await writable.abort().catch(() => {})
    }
    clearTransfer()
    throw error
  }
}

const readFooter = async (file: File): Promise<BundleFooter> => {
  if (file.size < 4) {
    throw new Error(translate('localModelImportInvalid'))
  }
  const lengthBuffer = await file.slice(file.size - 4).arrayBuffer()
  const length = new DataView(lengthBuffer).getUint32(0, true)
  if (!length || length < 2 || length > file.size - 4) {
    throw new Error(translate('localModelImportInvalid'))
  }
  const footerBuffer = await file.slice(file.size - 4 - length, file.size - 4).arrayBuffer()
  let footer: unknown
  try {
    footer = JSON.parse(new TextDecoder().decode(footerBuffer))
  } catch {
    throw new Error(translate('localModelImportInvalid'))
  }
  const value = footer as Partial<BundleFooter>
  if (value.format !== BUNDLE_FORMAT || !Array.isArray(value.entries) || !value.modelId) {
    throw new Error(translate('localModelImportInvalid'))
  }
  if (!value.entries.every((entry) => SCOPES.includes(entry.scope))) {
    throw new Error(translate('localModelImportInvalid'))
  }
  return {
    format: BUNDLE_FORMAT,
    version: value.version ?? BUNDLE_VERSION,
    engine: 'webllm',
    modelId: value.modelId,
    modelBase: value.modelBase ?? '',
    modelLib: value.modelLib ?? '',
    createdAt: value.createdAt ?? Date.now(),
    entries: value.entries,
  }
}

/**
 * 导入模型包：按 footer 的文件表逐段写回对应缓存。
 * 导入完成后重新检测缓存，模型立即出现在聊天栏的可选列表里。
 */
export const importModel = async (file: File): Promise<ImportResult> => {
  ensureCacheApi()
  const footer = await readFooter(file)
  setTransfer('import', footer.modelId, 0, translate('localModelImportPreparing'))
  const record = findWebllmRecord(footer.modelId)
  let size = 0
  let fileCount = 0
  try {
    for (let index = 0; index < footer.entries.length; index += 1) {
      const entry = footer.entries[index]
      const end = entry.offset + entry.size
      if (entry.offset < 0 || end > file.size || entry.size <= 0) {
        throw new Error(translate('localModelImportInvalid'))
      }
      const cache = await caches.open(entry.scope)
      const response = new Response(file.slice(entry.offset, end), {
        headers: entry.type ? { 'Content-Type': entry.type } : undefined,
      })
      await cache.put(new Request(entry.url), response)
      size += entry.size
      fileCount += 1
      setTransfer(
        'import',
        footer.modelId,
        index / footer.entries.length,
        translate('localModelImportProgress', { done: index + 1, total: footer.entries.length })
      )
    }
    // 导入后立刻验证：缺文件（例如导出中断）时提示用户重新导入
    if (record) {
      const downloaded = await checkDownloaded(footer.modelId)
      if (downloaded) {
        useLocalModels.setState((current) => ({
          downloaded: { ...current.downloaded, [footer.modelId]: true },
        }))
      }
    }
    setTransfer('import', footer.modelId, 1, translate('localModelImportDone'))
    setTimeout(clearTransfer, 800)
    return { modelId: footer.modelId, fileCount, size }
  } catch (error) {
    clearTransfer()
    throw error
  }
}

/** 缓存后端是否支持导出：只有 Cache API 能按 URL 枚举 */
export const transferSupported = (): boolean =>
  localAppConfig().cacheBackend === 'cache' && typeof caches !== 'undefined'
