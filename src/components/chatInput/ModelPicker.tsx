import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconRefreshOutline16,
} from '../base/icons.js'
import {
  BUILTIN_MODELS,
  fetchRemoteModels,
  modelLabel,
  readCachedModels,
  type ModelOption,
} from '../../services/api/models.js'
import { setModel, useSettings } from '../../services/settings.js'
import { formatMoney, isKnownModel, modelPriceFor } from '../../services/chat/sessionStats.js'
import {
  localCatalog,
  refreshMlcModels,
  selectLocalModel,
  useLocalModels,
} from '../../services/local/store.js'
import {
  isLocalModel,
  mlcSelection,
  webllmModelId,
  webllmSelection,
} from '../../services/local/catalog.js'
import { refreshDownloaded } from '../../services/local/engine.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ModelPicker.module.css'

const mergeModels = (remote: ModelOption[]): ModelOption[] => {
  const seen = new Set(remote.map((item) => item.id))
  return [...remote, ...BUILTIN_MODELS.filter((item) => !seen.has(item.id))]
}

/** 每个模型下方的价格：命中 / 未命中 / 输出，单位每 1M tokens */
const priceText = (model: string, t: ReturnType<typeof useTranslate>): string => {
  if (isLocalModel(model)) {
    return t('modelPriceLocalFree')
  }
  if (!isKnownModel(model)) {
    return t('modelPriceUnknown')
  }
  const price = modelPriceFor(model)
  return `${formatMoney(price.cacheHit)} / ${formatMoney(price.cacheMiss)} / ${formatMoney(price.output)}`
}

/**
 * 模型选择卡片：默认内置 Flash / V4 Pro，可从云端 GET /models 拉取并缓存；
 * 本地模型（浏览器 WebLLM 已下载的权重、MLC-LLM API 的模型）排在最前，
 * 切换后下一条消息就走对应后端，旧回复保留自己的模型与计费。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const model = useSettings((state) => state.model)
  const downloaded = useLocalModels((state) => state.downloaded)
  const catalogSynced = useLocalModels((state) => state.catalogSynced)
  const mlcModels = useLocalModels((state) => state.mlcModels)
  const mlcEndpoint = useLocalModels((state) => state.mlcEndpoint)
  const gpu = useLocalModels((state) => state.gpu)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>(() => mergeModels(readCachedModels() ?? []))
  const [loading, setLoading] = useState(false)
  const fetched = useRef(false)

  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'start',
    offset: 8,
    maxHeight: 360,
    minSpace: 220,
    measureKey: models.length + Object.keys(downloaded).length,
  })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const localOptions = useMemo<ModelOption[]>(() => {
    const list = localCatalog()
      .filter((item) => downloaded[item.id] || webllmSelection(item.id) === model)
      .map((item) => ({
        id: webllmSelection(item.id),
        label: `${item.familyLabel} ${item.name}`,
        source: 'local' as const,
      }))
    return list
  }, [downloaded, model])

  const mlcOptions = useMemo<ModelOption[]>(
    () =>
      mlcModels.map((item) => ({
        id: mlcSelection(item.id),
        label: item.label,
        source: 'mlc' as const,
      })),
    [mlcModels]
  )

  const refresh = useCallback(async (silent = false) => {
    const apiKey = useSettings.getState().apiKey ?? ''
    if (!apiKey) {
      if (!silent) {
        showToast({ key: 'modelFetchFailed' })
      }
      return
    }
    setLoading(true)
    try {
      const remote = await fetchRemoteModels(apiKey)
      setModels(mergeModels(remote))
    } catch {
      if (!silent) {
        showToast({ key: 'modelFetchFailed' })
      }
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次打开且没有缓存时静默拉一次；失败继续用内置列表
  useEffect(() => {
    if (!open || fetched.current) {
      return
    }
    fetched.current = true
    if (!readCachedModels()) {
      void refresh(true)
    }
  }, [open, refresh])

  // 第一次展开时同步「哪些本地模型已经下载」，之后每次导入/删除都会主动刷新
  useEffect(() => {
    if (!open || catalogSynced) {
      return
    }
    void refreshDownloaded()
  }, [open, catalogSynced])

  // 配置了 MLC-LLM 地址但还没有模型列表时拉一次，失败只留在本地模型设置里提示
  useEffect(() => {
    if (!open || mlcModels.length > 0 || !mlcEndpoint.trim()) {
      return
    }
    void refreshMlcModels()
  }, [open, mlcModels.length, mlcEndpoint])

  const sourceText = useMemo(() => {
    if (loading) {
      return t('modelFetching')
    }
    const count = models.filter((item) => item.source === 'remote').length
    return count > 0 ? t('modelRemoteOk', { count }) : t('modelBuiltinFallback')
  }, [loading, models, t])

  const choose = (item: ModelOption) => {
    if (item.source === 'local' || item.source === 'mlc') {
      selectLocalModel(item.id)
      if (item.source === 'local' && !downloaded[webllmModelId(item.id)]) {
        showToast({ key: 'localModelWillDownload' })
      }
    } else {
      setModel(item.id)
    }
    setOpen(false)
  }

  const localSection =
    localOptions.length > 0 || mlcOptions.length > 0 ? (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <span>{t('localModelsSection')}</span>
          <button
            type="button"
            className={styles.manage}
            onClick={() => {
              setOpen(false)
              openSettings('local')
            }}
          >
            {t('localModelsManage')}
          </button>
        </div>
        {[...localOptions, ...mlcOptions].map((item) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={item.id === model}
            className={clsx(styles.option, item.id === model && styles.active)}
            onClick={() => choose(item)}
          >
            <span className={styles.optionMain}>
              <span className={styles.optionNameRow}>
                <span className={styles.optionName}>{item.label}</span>
                <span className={styles.sourceTag}>
                  {item.source === 'local' ? t('modelSourceLocal') : t('modelSourceMlc')}
                </span>
              </span>
              <span className={styles.optionId}>{item.id}</span>
              <span className={styles.optionPrice}>{priceText(item.id, t)}</span>
            </span>
            {item.id === model ? <IconCheckedOutline14 /> : null}
          </button>
        ))}
      </div>
    ) : (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <span>{t('localModelsSection')}</span>
          <button
            type="button"
            className={styles.manage}
            onClick={() => {
              setOpen(false)
              openSettings('local')
            }}
          >
            {t('localModelsManage')}
          </button>
        </div>
        <div className={styles.localEmpty}>
          {gpu && !gpu.supported ? t('localModelsGpuMissingHint') : t('localModelsEmptyHint')}
        </div>
      </div>
    )

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open)}
        aria-label={`${t('modelSelect')}: ${modelLabel(model)}`}
        title={modelLabel(model)}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.name}>{modelLabel(model)}</span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="listbox"
              aria-label={t('modelSelect')}
            >
              <div className={styles.head}>
                <span className={styles.title}>{t('modelSelect')}</span>
                <button
                  type="button"
                  className={clsx(styles.refresh, loading && styles.spinning)}
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <IconRefreshOutline16 />
                  {loading ? t('modelFetching') : t('modelFetch')}
                </button>
              </div>
              {localSection}
              <div className={styles.list}>
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === model}
                    className={clsx(styles.option, item.id === model && styles.active)}
                    onClick={() => choose(item)}
                  >
                    <span className={styles.optionMain}>
                      <span className={styles.optionNameRow}>
                        <span className={styles.optionName}>{item.label}</span>
                        <span className={styles.sourceTag}>
                          {item.source === 'remote' ? t('modelRemote') : t('modelBuiltin')}
                        </span>
                      </span>
                      <span className={styles.optionId}>{item.id}</span>
                      <span className={styles.optionPrice}>{priceText(item.id, t)}</span>
                    </span>
                    {item.id === model ? <IconCheckedOutline14 /> : null}
                  </button>
                ))}
              </div>
              <div className={styles.foot}>
                <span>{sourceText}</span>
                <span>
                  {t('modelPriceNote')} · {t('modelPriceUnitShort')}
                </span>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
