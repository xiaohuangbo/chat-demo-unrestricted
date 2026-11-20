import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import { ParamControl } from '../settings/ParamControls.js'
import { modelLabel } from '../../services/api/models.js'
import { isWebllmModel, webllmModelId, webllmSelection } from '../../services/local/catalog.js'
import {
  deleteModel,
  disposeEngine,
  loadModel,
  probeGpu,
  refreshDownloaded,
} from '../../services/local/engine.js'
import { exportModel, importModel, transferSupported } from '../../services/local/transfer.js'
import {
  LOCAL_CONTEXT_WINDOWS,
  localCatalog,
  refreshMlcModels,
  selectLocalModel,
  setLocalSettings,
  useLocalModels,
  type WebllmCacheBackend,
} from '../../services/local/store.js'
import { useSettings } from '../../services/settings.js'
import nanoStyles from '../nanovm/NanoVM.module.css'
import styles from './LocalModelSettings.module.css'

/**
 * 设置 → 本地模型。
 *
 * 三块内容：
 * 1. 浏览器 WebGPU 模型：目录来自 @mlc-ai/web-llm 的 prebuiltAppConfig，
 *    支持在线下载（加载即缓存）、切换、删除、导出为 `.mlcmodel` 模型包；
 * 2. MLC-LLM API：填写自建服务地址后拉取 /v1/models，选中即走远端推理；
 * 3. 模型包导入 + 采样参数 + 缓存后端等运行配置。
 *
 * 下载进度来自 Worker 的 initProgressCallback，导出/导入进度来自 transfer 状态。
 */
export const LocalModelSettings = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const status = useLocalModels((state) => state.status)
  const progress = useLocalModels((state) => state.progress)
  const progressText = useLocalModels((state) => state.progressText)
  const error = useLocalModels((state) => state.error)
  const downloaded = useLocalModels((state) => state.downloaded)
  const downloadingId = useLocalModels((state) => state.downloadingId)
  const loadedModelId = useLocalModels((state) => state.loadedModelId)
  const gpu = useLocalModels((state) => state.gpu)
  const gpuChecking = useLocalModels((state) => state.gpuChecking)
  const transfer = useLocalModels((state) => state.transfer)
  const catalogSynced = useLocalModels((state) => state.catalogSynced)
  const mlcModels = useLocalModels((state) => state.mlcModels)
  const mlcLoading = useLocalModels((state) => state.mlcLoading)
  const mlcError = useLocalModels((state) => state.mlcError)
  const mlcEndpoint = useLocalModels((state) => state.mlcEndpoint)
  const cacheBackend = useLocalModels((state) => state.cacheBackend)
  const contextWindow = useLocalModels((state) => state.contextWindow)
  const temperature = useLocalModels((state) => state.temperature)
  const topP = useLocalModels((state) => state.topP)
  const maxTokens = useLocalModels((state) => state.maxTokens)
  const presencePenalty = useLocalModels((state) => state.presencePenalty)
  const frequencyPenalty = useLocalModels((state) => state.frequencyPenalty)
  const enableThinking = useLocalModels((state) => state.enableThinking)
  const autoLoad = useLocalModels((state) => state.autoLoad)

  const [query, setQuery] = useState('')
  const [onlyDownloaded, setOnlyDownloaded] = useState(false)
  const [endpointDraft, setEndpointDraft] = useState(mlcEndpoint)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const catalog = useMemo(() => localCatalog(), [])

  useEffect(() => {
    setEndpointDraft(mlcEndpoint)
  }, [mlcEndpoint])

  // 首次打开设置卡片：探测 WebGPU 并同步已下载模型，避免列表全部显示成未下载
  useEffect(() => {
    if (!gpu && !gpuChecking) {
      void probeGpu()
    }
    if (!catalogSynced) {
      void refreshDownloaded()
    }
  }, [gpu, gpuChecking, catalogSynced])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return catalog.filter((item) => {
      if (onlyDownloaded && !downloaded[item.id]) {
        return false
      }
      if (!keyword) {
        return true
      }
      return (
        item.id.toLowerCase().includes(keyword) ||
        item.name.toLowerCase().includes(keyword) ||
        item.provider.toLowerCase().includes(keyword) ||
        item.familyLabel.toLowerCase().includes(keyword)
      )
    })
  }, [catalog, query, onlyDownloaded, downloaded])

  const downloadedCount = useMemo(
    () => catalog.filter((item) => downloaded[item.id]).length,
    [catalog, downloaded]
  )

  const fail = (key: TranslationKey, reason: unknown) =>
    showToast({
      key,
      type: 'error',
      params: { reason: reason instanceof Error ? reason.message : String(reason) },
    })

  const download = async (modelId: string) => {
    setBusyId(modelId)
    try {
      await loadModel(modelId)
      showToast({
        key: 'localModelDownloadDone',
        params: { model: modelLabel(webllmSelection(modelId)) },
      })
    } catch (reason) {
      fail('localModelDownloadFailed', reason)
    } finally {
      setBusyId(null)
    }
  }

  const useModel = async (modelId: string) => {
    selectLocalModel(webllmSelection(modelId))
    showToast({
      key: 'localModelSelected',
      params: { model: modelLabel(webllmSelection(modelId)) },
    })
    if (!downloaded[modelId]) {
      await download(modelId)
    }
  }

  const removeModel = async (modelId: string) => {
    setConfirmDelete(null)
    setBusyId(modelId)
    try {
      await deleteModel(modelId)
      await refreshDownloaded([modelId])
      showToast({ key: 'localModelDeleted' })
    } catch (reason) {
      fail('localModelDeleteFailedToast', reason)
    } finally {
      setBusyId(null)
    }
  }

  const doExport = async (modelId: string) => {
    setBusyId(modelId)
    try {
      const result = await exportModel(modelId)
      if (!result.saved && result.blob) {
        const url = URL.createObjectURL(result.blob)
        const link = document.createElement('a')
        link.href = url
        link.download = result.fileName
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      showToast({
        key: 'localModelExportDoneToast',
        params: { model: modelLabel(webllmSelection(modelId)), size: formatSize(result.size) },
      })
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        return
      }
      fail('localModelExportFailed', reason)
    } finally {
      setBusyId(null)
    }
  }

  const doImport = async (file: File) => {
    try {
      const result = await importModel(file)
      await refreshDownloaded([result.modelId])
      showToast({
        key: 'localModelImportDoneToast',
        params: {
          model: modelLabel(webllmSelection(result.modelId)),
          size: formatSize(result.size),
        },
      })
    } catch (reason) {
      fail('localModelImportFailed', reason)
    }
  }

  const changeBackend = async (next: WebllmCacheBackend) => {
    if (next === cacheBackend) {
      return
    }
    await disposeEngine()
    setLocalSettings({ cacheBackend: next })
    await refreshDownloaded()
    showToast({ key: 'localModelCacheChanged' })
  }

  const webview = typeof navigator !== 'undefined' && /;\s*wv\b/i.test(navigator.userAgent)
  const gpuOk = gpu?.supported === true
  const busy = status === 'loading' || transfer !== null
  const selectedWebllm = isWebllmModel(model) ? webllmModelId(model) : null

  return (
    <div className={nanoStyles.console}>
      <div className={nanoStyles.groupTitle}>{t('localModelsTitle')}</div>
      <div className={nanoStyles.hint}>{t('localModelsHint')}</div>

      <div className={nanoStyles.card}>
        <div className={styles.statusRow}>
          <span className={styles.dot} data-status={status} />
          <span className={styles.statusText}>
            {gpuChecking
              ? t('localModelGpuChecking')
              : gpuOk
                ? t('localModelGpuReady', {
                    info: [gpu?.vendor, gpu?.architecture].filter(Boolean).join(' ') || 'WebGPU',
                  })
                : t('localModelGpuUnavailable')}
          </span>
          <Button
            size="s"
            variant="outlined"
            disabled={gpuChecking}
            onClick={() => void probeGpu()}
          >
            {t('localModelGpuRecheck')}
          </Button>
        </div>
        {!gpuOk && !gpuChecking ? (
          <div className={styles.warn}>
            {webview ? t('localModelWebViewHint') : (gpu?.reason ?? t('localModelGpuMissing'))}
          </div>
        ) : null}
        {status === 'loading' ? (
          <div className={styles.progressWrap}>
            <div className={styles.progressBar}>
              <div
                className={styles.progressFill}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div className={styles.progressText}>
              {downloadingId ? `${modelLabel(webllmSelection(downloadingId))} · ` : ''}
              {progressText || `${Math.round(progress * 100)}%`}
            </div>
          </div>
        ) : status === 'ready' && loadedModelId ? (
          <div className={styles.okRow}>
            {t('localModelLoaded', { model: modelLabel(webllmSelection(loadedModelId)) })}
          </div>
        ) : null}
        {error ? <div className={styles.warn}>{error}</div> : null}
        {transfer ? (
          <div className={styles.progressWrap}>
            <div className={styles.progressText}>
              {transfer.kind === 'export' ? t('localModelExporting') : t('localModelImporting')} ·{' '}
              {transfer.text}
            </div>
            {transfer.percent === null ? null : (
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${Math.round(transfer.percent * 100)}%` }}
                />
              </div>
            )}
          </div>
        ) : null}
        <div className={styles.currentModel}>
          {t('localModelCurrent')}: <span className={styles.currentName}>{modelLabel(model)}</span>
          {selectedWebllm ? (
            <span className={styles.currentMeta}>
              {downloaded[selectedWebllm]
                ? t('localModelDownloaded')
                : t('localModelNotDownloadedShort')}
            </span>
          ) : null}
        </div>
        <div className={styles.actions}>
          <Button
            size="s"
            variant="outlined"
            disabled={!transferSupported()}
            onClick={() => fileRef.current?.click()}
          >
            {t('localModelImport')}
          </Button>
          {selectedWebllm ? (
            <Button
              size="s"
              variant="outlined"
              disabled={!downloaded[selectedWebllm] || busy}
              onClick={() => void doExport(selectedWebllm)}
            >
              {t('localModelExportCurrent')}
            </Button>
          ) : null}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".mlcmodel"
          className={styles.hiddenInput}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void doImport(file)
            }
          }}
        />
        <div className={nanoStyles.hint}>{t('localModelTransferHint')}</div>
      </div>

      <div className={nanoStyles.groupTitle}>{t('localModelBrowserModels')}</div>
      <div className={nanoStyles.card}>
        <div className={styles.searchRow}>
          <input
            className={styles.input}
            value={query}
            placeholder={t('localModelSearchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className={styles.filter}>
            <input
              type="checkbox"
              checked={onlyDownloaded}
              onChange={(event) => setOnlyDownloaded(event.target.checked)}
            />
            {t('localModelOnlyDownloaded', { count: downloadedCount })}
          </label>
        </div>
        <div className={styles.modelList}>
          {filtered.length === 0 ? (
            <div className={nanoStyles.hint}>{t('localModelSearchEmpty')}</div>
          ) : (
            filtered.map((item) => {
              const isDownloaded = downloaded[item.id] === true
              const isLoaded = loadedModelId === item.id
              const isSelected = selectedWebllm === item.id
              return (
                <div
                  key={item.id}
                  className={styles.modelRow}
                  data-active={isSelected || undefined}
                >
                  <div className={styles.modelMain}>
                    <div className={styles.modelName}>
                      {item.familyLabel} {item.name}
                      {item.size ? <span className={styles.chip}>{item.size}</span> : null}
                      {item.quantization ? (
                        <span className={styles.chip}>{item.quantization}</span>
                      ) : null}
                      {item.lowResource ? (
                        <span className={styles.chip}>{t('localModelLowResource')}</span>
                      ) : null}
                    </div>
                    <div className={styles.modelMeta}>
                      {item.provider}
                      {item.vramMB ? ` · ${Math.round(item.vramMB)} MB VRAM` : ''}
                      {` · ${t('localModelContextShort', { size: formatContext(item.contextWindow) })}`}
                      {isDownloaded ? ` · ${t('localModelDownloaded')}` : ''}
                      {isLoaded ? ` · ${t('localModelInMemory')}` : ''}
                    </div>
                    <div className={styles.modelId}>{item.id}</div>
                  </div>
                  <div className={styles.modelActions}>
                    {isSelected ? (
                      <span className={styles.activeBadge}>{t('localModelUsing')}</span>
                    ) : (
                      <Button
                        size="s"
                        variant="outlined"
                        disabled={busy}
                        onClick={() => void useModel(item.id)}
                      >
                        {t('localModelUse')}
                      </Button>
                    )}
                    {!isDownloaded ? (
                      <Button
                        size="s"
                        disabled={busy || !gpuOk}
                        onClick={() => void download(item.id)}
                      >
                        {downloadingId === item.id
                          ? t('localModelDownloading')
                          : t('localModelDownload')}
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="s"
                          variant="outlined"
                          disabled={busy}
                          onClick={() => void doExport(item.id)}
                        >
                          {t('localModelExport')}
                        </Button>
                        {confirmDelete === item.id ? (
                          <Button
                            size="s"
                            variant="dangerOutlined"
                            disabled={busy}
                            onClick={() => void removeModel(item.id)}
                          >
                            {t('localModelDeleteConfirm')}
                          </Button>
                        ) : (
                          <Button
                            size="s"
                            variant="dangerOutlined"
                            disabled={busy || isLoaded}
                            onClick={() => setConfirmDelete(item.id)}
                          >
                            {t('localModelDelete')}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
        <div className={nanoStyles.hint}>
          {t('localModelDownloadHint', { count: catalog.length })}
        </div>
        {busyId ? (
          <div className={nanoStyles.hint}>{t('localModelWorking', { model: busyId })}</div>
        ) : null}
      </div>

      <div className={nanoStyles.groupTitle}>{t('localModelMlcTitle')}</div>
      <div className={nanoStyles.card}>
        <div className={nanoStyles.hint}>{t('localModelMlcHint')}</div>
        <div className={styles.searchRow}>
          <input
            className={styles.input}
            value={endpointDraft}
            placeholder="http://127.0.0.1:8000"
            spellCheck={false}
            onChange={(event) => setEndpointDraft(event.target.value)}
            onBlur={() => setLocalSettings({ mlcEndpoint: endpointDraft })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                setLocalSettings({ mlcEndpoint: endpointDraft })
                void refreshMlcModels()
              }
            }}
          />
          <Button
            size="s"
            disabled={mlcLoading}
            onClick={() => {
              setLocalSettings({ mlcEndpoint: endpointDraft })
              void refreshMlcModels()
            }}
          >
            {mlcLoading ? t('localModelMlcConnecting') : t('localModelMlcConnect')}
          </Button>
        </div>
        {mlcError ? <div className={styles.warn}>{mlcError}</div> : null}
        {mlcModels.length === 0 ? (
          <div className={nanoStyles.hint}>{t('localModelMlcEmpty')}</div>
        ) : (
          <div className={styles.modelList}>
            {mlcModels.map((item) => {
              const selection = `mlc/${item.id}`
              return (
                <div
                  key={item.id}
                  className={styles.modelRow}
                  data-active={selection === model || undefined}
                >
                  <div className={styles.modelMain}>
                    <div className={styles.modelName}>{item.label}</div>
                    <div className={styles.modelId}>{item.id}</div>
                  </div>
                  <div className={styles.modelActions}>
                    {selection === model ? (
                      <span className={styles.activeBadge}>{t('localModelUsing')}</span>
                    ) : (
                      <Button
                        size="s"
                        variant="outlined"
                        onClick={() => selectLocalModel(selection)}
                      >
                        {t('localModelUse')}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className={nanoStyles.groupTitle}>{t('localModelParams')}</div>
      <div className={nanoStyles.card}>
        <div className={nanoStyles.switchText}>
          <div className={nanoStyles.switchLabel}>{t('localModelCacheBackend')}</div>
          <div className={nanoStyles.hint}>{t('localModelCacheBackendHint')}</div>
        </div>
        <Select
          value={cacheBackend}
          ariaLabel={t('localModelCacheBackend')}
          options={[
            { value: 'cache', label: 'Cache Storage' },
            { value: 'indexeddb', label: 'IndexedDB' },
          ]}
          onChange={(value) => void changeBackend(value as WebllmCacheBackend)}
        />
        <div className={nanoStyles.switchText}>
          <div className={nanoStyles.switchLabel}>{t('localModelContextWindow')}</div>
          <div className={nanoStyles.hint}>{t('localModelContextWindowHint')}</div>
        </div>
        <Select
          value={contextWindow === null ? 'auto' : String(contextWindow)}
          ariaLabel={t('localModelContextWindow')}
          options={[
            { value: 'auto', label: t('localModelContextAuto') },
            ...LOCAL_CONTEXT_WINDOWS.map((size) => ({
              value: String(size),
              label: formatContext(size),
            })),
          ]}
          onChange={(value) =>
            setLocalSettings({ contextWindow: value === 'auto' ? null : Number(value) })
          }
        />
        <ParamControl
          label={`${t('localModelTemperature')}`}
          value={temperature}
          min={0}
          max={2}
          step={0.1}
          onChange={(value) => setLocalSettings({ temperature: value ?? 0.7 })}
        />
        <ParamControl
          label={`${t('localModelTopP')}`}
          value={topP}
          min={0}
          max={1}
          step={0.05}
          onChange={(value) => setLocalSettings({ topP: value ?? 1 })}
        />
        <ParamControl
          label={`${t('localModelMaxTokens')}`}
          value={maxTokens}
          min={256}
          max={32768}
          step={256}
          onChange={(value) => setLocalSettings({ maxTokens: value ?? 2048 })}
        />
        <ParamControl
          label={`${t('localModelPresencePenalty')}`}
          value={presencePenalty}
          min={-2}
          max={2}
          step={0.1}
          onChange={(value) => setLocalSettings({ presencePenalty: value ?? 0 })}
        />
        <ParamControl
          label={`${t('localModelFrequencyPenalty')}`}
          value={frequencyPenalty}
          min={-2}
          max={2}
          step={0.1}
          onChange={(value) => setLocalSettings({ frequencyPenalty: value ?? 0 })}
        />
        <div className={nanoStyles.switchRow}>
          <div className={nanoStyles.switchText}>
            <div className={nanoStyles.switchLabel}>{t('localModelEnableThinking')}</div>
            <div className={nanoStyles.hint}>{t('localModelEnableThinkingHint')}</div>
          </div>
          <Switch
            checked={enableThinking}
            onChange={(value) => setLocalSettings({ enableThinking: value })}
            label={t('localModelEnableThinking')}
          />
        </div>
        <div className={nanoStyles.switchRow}>
          <div className={nanoStyles.switchText}>
            <div className={nanoStyles.switchLabel}>{t('localModelAutoLoad')}</div>
            <div className={nanoStyles.hint}>{t('localModelAutoLoadHint')}</div>
          </div>
          <Switch
            checked={autoLoad}
            onChange={(value) => setLocalSettings({ autoLoad: value })}
            label={t('localModelAutoLoad')}
          />
        </div>
        <div className={nanoStyles.hint}>{t('localModelParamsHint')}</div>
      </div>
    </div>
  )
}

/** 上下文窗口按 1K / 4K / 128K 展示 */
const formatContext = (size: number): string =>
  size >= 1024 ? `${Math.round(size / 1024)}K` : String(size)

/** 模型包大小按 MB / GB 展示 */
const formatSize = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`
