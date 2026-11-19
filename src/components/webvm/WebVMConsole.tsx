import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import {
  WEBVM_IMAGES,
  isWebVmImageUrl,
  setWebVMAllowAgent,
  setWebVMConfig,
  setWebVMEnabled,
  useWebVMConfig,
  type WebVmImageId,
} from '../../services/webvm/config.js'
import {
  bootWebVm,
  checkWebVmEnvironment,
  exportWebVmHome,
  importWebVmFiles,
  resetWebVm,
  restartWebVm,
  stopWebVm,
  useWebVM,
} from '../../services/webvm/session.js'
import { enableCrossOriginIsolation, readCoiState } from '../../services/webvm/coi.js'
import { WebVmResetDialog } from './WebVmResetDialog.js'
import nanoStyles from '../nanovm/NanoVM.module.css'
import styles from './WebVM.module.css'

/** 一行开关：左侧说明 + 右侧方块开关，和 NanoVM 控制台一致 */
const SwitchRow = ({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
}) => (
  <div className={nanoStyles.switchRow}>
    <div className={nanoStyles.switchText}>
      <div className={nanoStyles.switchLabel}>{label}</div>
      <div className={nanoStyles.hint}>{hint}</div>
    </div>
    <Switch checked={checked} onChange={onChange} label={label} />
  </div>
)

/**
 * 设置 → 虚拟机 → WebVM 控制台。
 *
 * 除了启停与镜像，这里把「跨源隔离」「导入导出」「编程环境检测」集中在一个
 * 卡片里，避免终端面板塞太多按钮。所有操作都复用 session 里的单例。
 */
export const WebVMConsole = () => {
  const t = useTranslate()
  const enabled = useWebVMConfig((state) => state.enabled)
  const allowAgent = useWebVMConfig((state) => state.allowAgent)
  const autoBoot = useWebVMConfig((state) => state.autoBoot)
  const imageId = useWebVMConfig((state) => state.imageId)
  const customImageUrl = useWebVMConfig((state) => state.customImageUrl)
  const command = useWebVMConfig((state) => state.command)
  const timeoutMs = useWebVMConfig((state) => state.timeoutMs)
  const status = useWebVM((state) => state.status)
  const error = useWebVM((state) => state.error)
  const bootMs = useWebVM((state) => state.bootMs)
  const busy = useWebVM((state) => state.busy)
  const coi = useWebVM((state) => state.coi)
  const coiReason = useWebVM((state) => state.coiReason)

  const [coiBusy, setCoiBusy] = useState(false)
  const [coiError, setCoiError] = useState<string | null>(null)
  const [imageDraft, setImageDraft] = useState(customImageUrl)
  const [imageError, setImageError] = useState(false)
  const [commandDraft, setCommandDraft] = useState(command)
  const [timeoutDraft, setTimeoutDraft] = useState(Math.round(timeoutMs / 1000))
  const [envText, setEnvText] = useState('')
  const [envBusy, setEnvBusy] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)

  // 配置在别处被重置时同步回输入框
  useEffect(() => {
    setImageDraft(customImageUrl)
    setCommandDraft(command)
    setTimeoutDraft(Math.round(timeoutMs / 1000))
  }, [command, customImageUrl, timeoutMs])

  const coiLabel =
    coi === 'isolated'
      ? t('webvmCoiIsolated')
      : coi === 'registerable'
        ? t('webvmStatusCoi')
        : t('webvmStatusUnsupported')

  const webview = coi === 'unsupported' && coiReason === 'webview'

  const statusText: Record<string, string> = {
    idle: t('webvmStatusIdle'),
    coi: coi === 'unsupported' ? t('webvmStatusUnsupported') : t('webvmStatusCoi'),
    loading: t('webvmStatusLoading'),
    connecting: t('webvmStatusConnecting'),
    booting: t('webvmStatusBooting'),
    ready: t('webvmStatusReady', { ms: bootMs ?? 0 }),
    error: t('webvmStatusError', { reason: error ?? '—' }),
  }

  const enableCoi = async () => {
    setCoiBusy(true)
    setCoiError(null)
    try {
      await enableCrossOriginIsolation()
      void bootWebVm()
    } catch (reason) {
      setCoiError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCoiBusy(false)
    }
  }

  const start = () => {
    const state = readCoiState()
    if (state.state !== 'isolated') {
      showToast({ key: 'webvmAgentNeedsCoi', type: 'error' })
      return
    }
    void bootWebVm()
  }

  const commitImage = (value: string) => {
    const next = value.trim()
    if (next && !isWebVmImageUrl(next)) {
      setImageError(true)
      return
    }
    setImageError(false)
    setWebVMConfig({ customImageUrl: next })
  }

  const onImport = async (files: File[]) => {
    if (files.length === 0) {
      return
    }
    try {
      const result = await importWebVmFiles(files)
      showToast({ key: 'webvmImportDone', params: { count: result.count } })
    } catch (reason) {
      showToast({
        key: 'webvmImportFailed',
        params: { reason: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    }
  }

  const onExport = async () => {
    try {
      const blob = await exportWebVmHome()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'webvm-home.tar.gz'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showToast({ key: 'webvmExportDone' })
    } catch (reason) {
      showToast({
        key: 'webvmExportFailed',
        params: { reason: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    }
  }

  const checkEnv = async () => {
    setEnvBusy(true)
    try {
      setEnvText(await checkWebVmEnvironment())
    } catch (reason) {
      setEnvText(
        t('webvmEnvFailed', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      )
    } finally {
      setEnvBusy(false)
    }
  }

  const reset = async () => {
    setResetOpen(false)
    try {
      await resetWebVm(true)
      showToast({ key: 'webvmResetDone' })
    } catch (reason) {
      showToast({
        key: 'webvmResetFailed',
        params: { reason: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    }
  }

  return (
    <div className={nanoStyles.console}>
      <div className={nanoStyles.groupTitle}>{t('webvmSettingsTitle')}</div>
      <div className={nanoStyles.hint}>{t('webvmSettingsHint')}</div>

      <div className={nanoStyles.card}>
        <SwitchRow
          label={t('webvmEnable')}
          hint={t('webvmEnableHint')}
          checked={enabled}
          onChange={setWebVMEnabled}
        />
        <SwitchRow
          label={t('webvmAllowAgent')}
          hint={t('webvmAllowAgentHint')}
          checked={allowAgent && enabled}
          onChange={setWebVMAllowAgent}
        />
        <SwitchRow
          label={t('webvmAutoBoot')}
          hint={t('webvmAutoBootHint')}
          checked={autoBoot}
          onChange={(value) => setWebVMConfig({ autoBoot: value })}
        />
      </div>

      <div className={nanoStyles.groupTitle}>{t('webvmImage')}</div>
      <div className={nanoStyles.card}>
        <div className={nanoStyles.switchText}>
          <div className={nanoStyles.switchLabel}>{t('webvmImage')}</div>
          <div className={nanoStyles.hint}>{t('webvmImageHint')}</div>
        </div>
        <Select
          value={imageId}
          ariaLabel={t('webvmImage')}
          options={[
            { value: 'debian', label: t('webvmImageDebian') },
            { value: 'debian-2023', label: t('webvmImageDebian2023') },
            { value: 'custom', label: t('webvmImageCustom') },
          ]}
          onChange={(value) => {
            setWebVMConfig({ imageId: value as WebVmImageId })
            if (value !== 'custom') {
              showToast({ key: 'nanovmApplyNext' })
            }
          }}
        />
        {imageId === 'debian' || imageId === 'debian-2023' ? (
          <div className={nanoStyles.hint}>
            {WEBVM_IMAGES[imageId].label} · {WEBVM_IMAGES[imageId].detail}
          </div>
        ) : (
          <>
            <input
              className={styles.settingsInput}
              value={imageDraft}
              placeholder={t('webvmImagePlaceholder')}
              aria-label={t('webvmImageUrl')}
              aria-invalid={imageError || undefined}
              spellCheck={false}
              onChange={(event) => {
                setImageDraft(event.target.value)
                setImageError(false)
              }}
              onBlur={() => commitImage(imageDraft)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitImage(imageDraft)
                }
              }}
            />
            {imageError ? <div className={styles.error}>{t('webvmImageInvalid')}</div> : null}
          </>
        )}
        <div className={nanoStyles.hint}>{t('webvmImageNote')}</div>
      </div>

      <div className={nanoStyles.groupTitle}>{t('webvmStatusTitle')}</div>
      <div className={nanoStyles.card}>
        <div className={styles.settingsValue}>{statusText[status] ?? status}</div>
        <div className={nanoStyles.hint}>{t('webvmCacheHint')}</div>
        <div className={styles.settingsValue}>
          {t('webvmImage')}:{' '}
          {imageId === 'custom'
            ? customImageUrl || '—'
            : t(imageId === 'debian-2023' ? 'webvmImageDebian2023' : 'webvmImageDebian')}
        </div>
        <div className={nanoStyles.hint}>{coiLabel}</div>
        {coiError ? <div className={styles.error}>{coiError}</div> : null}
        <div className={styles.settingsActions}>
          {coi === 'registerable' ? (
            <Button size="s" disabled={coiBusy} onClick={() => void enableCoi()}>
              {coiBusy ? t('webvmCoiReloading') : t('webvmCoiButton')}
            </Button>
          ) : null}
          <Button size="s" variant="outlined" disabled={webview} onClick={start}>
            {t('webvmStart')}
          </Button>
          <Button size="s" variant="outlined" disabled={webview} onClick={stopWebVm}>
            {t('webvmStop')}
          </Button>
          <Button
            size="s"
            variant="outlined"
            disabled={webview}
            onClick={() => void restartWebVm()}
          >
            {t('webvmRetry')}
          </Button>
          <Button
            size="s"
            variant="dangerOutlined"
            disabled={webview}
            onClick={() => setResetOpen(true)}
          >
            {t('webvmReset')}
          </Button>
        </div>
        {webview ? (
          <>
            <div className={styles.error}>{t('webvmCoiWebView')}</div>
            <div className={styles.settingsActions}>
              <Button
                size="s"
                onClick={() =>
                  window.open(
                    'https://chat-unrestricted.fur0.com/',
                    '_blank',
                    'noopener,noreferrer'
                  )
                }
              >
                {t('webvmOpenBrowser')}
              </Button>
            </div>
          </>
        ) : coi === 'unsupported' ? (
          <div className={styles.error}>{t('webvmCoiUnsupported')}</div>
        ) : null}
      </div>

      <div className={nanoStyles.groupTitle}>
        {t('webvmImport')} / {t('webvmExport')}
      </div>
      <div className={nanoStyles.card}>
        <div className={nanoStyles.hint}>{t('webvmImportHint')}</div>
        <div className={styles.settingsActions}>
          <Button size="s" disabled={busy !== null} onClick={() => importRef.current?.click()}>
            {t('webvmImport')}
          </Button>
          <Button
            size="s"
            variant="outlined"
            disabled={busy !== null || status !== 'ready'}
            onClick={() => void onExport()}
          >
            {t('webvmExport')}
          </Button>
        </div>
        <div className={nanoStyles.hint}>{t('webvmExportHint')}</div>
      </div>

      <div className={nanoStyles.groupTitle}>{t('webvmEnv')}</div>
      <div className={nanoStyles.card}>
        <div className={nanoStyles.hint}>{t('webvmEnvHint')}</div>
        <div className={styles.settingsActions}>
          <Button size="s" disabled={envBusy || status !== 'ready'} onClick={() => void checkEnv()}>
            {envBusy ? t('webvmEnvBusy') : t('webvmEnvCheck')}
          </Button>
        </div>
        {envText ? <pre className={styles.envPre}>{envText}</pre> : null}
        <div className={nanoStyles.hint}>{t('webvmNoNetwork')}</div>
      </div>

      <div className={nanoStyles.groupTitle}>{t('webvmAdvanced')}</div>
      <div className={nanoStyles.card}>
        <label className={nanoStyles.switchText} htmlFor="webvm-command">
          <span className={nanoStyles.switchLabel}>{t('webvmCommand')}</span>
          <span className={nanoStyles.hint}>{t('webvmStartHint')}</span>
        </label>
        <input
          id="webvm-command"
          className={styles.settingsInput}
          value={commandDraft}
          spellCheck={false}
          onChange={(event) => setCommandDraft(event.target.value)}
          onBlur={() => {
            setWebVMConfig({ command: commandDraft })
            showToast({ key: 'nanovmApplyNext' })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              setWebVMConfig({ command: commandDraft })
              showToast({ key: 'nanovmApplyNext' })
            }
          }}
        />
        <label className={nanoStyles.switchText} htmlFor="webvm-timeout">
          <span className={nanoStyles.switchLabel}>{t('nanovmTimeout')}</span>
          <span className={nanoStyles.hint}>{t('nanovmTimeoutHint')}</span>
        </label>
        <input
          id="webvm-timeout"
          className={styles.settingsInput}
          type="number"
          min={5}
          max={120}
          value={timeoutDraft}
          onChange={(event) => setTimeoutDraft(Number(event.target.value))}
          onBlur={() => {
            const seconds = Math.min(120, Math.max(5, Math.round(timeoutDraft) || 30))
            setTimeoutDraft(seconds)
            setWebVMConfig({ timeoutMs: seconds * 1000 })
          }}
        />
      </div>

      <div className={nanoStyles.hint}>{t('webvmAttribution')}</div>
      <div className={nanoStyles.hint}>
        <a href="https://cheerpx.io" target="_blank" rel="noreferrer">
          cheerpx.io
        </a>
      </div>

      <input
        ref={importRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void onImport(files)
        }}
      />
      {resetOpen ? (
        <WebVmResetDialog onClose={() => setResetOpen(false)} onConfirm={() => void reset()} />
      ) : null}
    </div>
  )
}
