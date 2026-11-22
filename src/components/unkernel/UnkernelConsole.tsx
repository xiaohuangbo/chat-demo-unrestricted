import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import {
  resetUnkernelConfig,
  setUnkernelConfig,
  useUnkernelConfig,
} from '../../services/unkernel/config.js'
import {
  openUnkernel,
  restartUnkernel,
  useUnkernel,
  waitForUnkernelVm,
} from '../../services/unkernel/session.js'
import {
  downloadGuestExport,
  exportGuestPath,
  formatBytes,
  importGuestFiles,
  MAX_EXPORT_BYTES,
  MAX_IMPORT_BYTES,
  normalizeGuestPath,
  saveGuestExportToWorkspace,
  type GuestImportOutcome,
} from '../../services/unkernel/files.js'
import { isWorkspaceEnabled } from '../../services/workspace/store.js'
import {
  enableCrossOriginIsolationForUnkernel,
  readCoiState,
} from '../../services/webvm/coi.js'
import { UNKERNEL_TOOLS } from '../../services/agent/unkernelTools.js'
import nanoStyles from '../nanovm/NanoVM.module.css'
import styles from './UnkernelConsole.module.css'

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
 * 设置 → unkernel：单独一栏，不和 NanoVM / WebVM 混在一起。
 *
 * 修改启动参数会重建 iframe，因此这里把「需要重启」写清楚；工作区会自动
 * 挂到 /mnt/workspace，Agent 与页面里的 shell 看到同一份文件。
 */
export const UnkernelConsole = () => {
  const t = useTranslate()
  const config = useUnkernelConfig()
  const status = useUnkernel((state) => state.status)
  const error = useUnkernel((state) => state.error)
  const workspaceMounted = useUnkernel((state) => state.workspaceMounted)
  const [wispDraft, setWispDraft] = useState(config.wispUrl)
  const [wispInvalid, setWispInvalid] = useState(false)
  const [timeoutDraft, setTimeoutDraft] = useState(Math.round(config.timeoutMs / 1000))
  const [importDir, setImportDir] = useState('/mnt/workspace')
  const [exportPath, setExportPath] = useState('/mnt/workspace')
  const [overwrite, setOverwrite] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importProgress, setImportProgress] = useState<string | null>(null)
  const [importResults, setImportResults] = useState<GuestImportOutcome[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [coiState] = useState(() => readCoiState())
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setWispDraft(config.wispUrl)
  }, [config.wispUrl])

  useEffect(() => {
    setTimeoutDraft(Math.round(config.timeoutMs / 1000))
  }, [config.timeoutMs])

  const commitWisp = () => {
    const value = wispDraft.trim()
    if (value && !/^wss?:\/\//i.test(value)) {
      setWispInvalid(true)
      return
    }
    setWispInvalid(false)
    setUnkernelConfig({ wispUrl: value })
  }

  const chooseCpus = (next: number) => {
    if (next === config.cpus) {
      return
    }
    if (next > 1 && coiState.state !== 'isolated') {
      if (coiState.state === 'registerable') {
        setUnkernelConfig({ cpus: next })
        showToast(t('unkernelCoiEnabling'))
        void enableCrossOriginIsolationForUnkernel().catch((reason: unknown) => {
          showToast(
            t('unkernelCoiFailed', {
              reason: reason instanceof Error ? reason.message : String(reason),
            })
          )
        })
        return
      }
      showToast(t('unkernelCoiUnsupported'))
      return
    }
    setUnkernelConfig({ cpus: next })
  }

  const chooseDistro = (distro: 'alpine' | 'debian') => {
    setUnkernelConfig({
      distro,
      // Debian 的 apt / Node 程序比 Alpine 吃内存，默认至少给 512 MiB。
      memoryMiB: distro === 'debian' ? Math.max(config.memoryMiB, 2048) : config.memoryMiB,
    })
  }

  const commitTimeout = () => {
    const seconds = Number(timeoutDraft)
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) {
      setTimeoutDraft(Math.round(config.timeoutMs / 1000))
      return
    }
    setUnkernelConfig({ timeoutMs: Math.round(seconds) * 1000 })
  }

  const pickFiles = () => {
    if (!importing) {
      fileInput.current?.click()
    }
  }

  const runImport = async (files: readonly File[]) => {
    if (!files.length || importing) {
      return
    }
    const target = importDir.trim()
    if (!normalizeGuestPath(target)) {
      showToast(t('unkernelInvalidGuestPath'))
      return
    }
    setImporting(true)
    setImportResults([])
    setImportProgress(files[0]?.name ?? null)
    try {
      const outcomes = await importGuestFiles(files, target, {
        overwrite,
        onProgress: (name, _index, done, total) =>
          setImportProgress(total > 0 ? `${name} · ${Math.min(100, Math.round((done / total) * 100))}%` : name),
      })
      setImportResults(outcomes)
      const done = outcomes.filter((item) => item.ok)
      const bytes = done.reduce((sum, item) => sum + item.bytes, 0)
      if (done.length) {
        showToast(
          t('unkernelImportDone', {
            count: done.length,
            size: formatBytes(bytes),
          })
        )
      } else {
        showToast(t('unkernelImportFailed', { reason: outcomes[0]?.error ?? '—' }))
      }
    } catch (error) {
      showToast(
        t('unkernelImportFailed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      setImporting(false)
      setImportProgress(null)
      if (fileInput.current) {
        fileInput.current.value = ''
      }
    }
  }

  const runExport = async (toWorkspace: boolean) => {
    if (exporting) {
      return
    }
    const target = exportPath.trim()
    if (!normalizeGuestPath(target)) {
      showToast(t('unkernelInvalidGuestPath'))
      return
    }
    setExporting(true)
    try {
      const vm = await waitForUnkernelVm()
      const result = await exportGuestPath(vm, target)
      if (toWorkspace) {
        const path = saveGuestExportToWorkspace(result)
        showToast(
          t('unkernelExportWorkspaceDone', {
            path,
            size: formatBytes(result.bytes.length),
          })
        )
      } else {
        downloadGuestExport(result)
        showToast(
          t('unkernelExportDone', { name: result.name, size: formatBytes(result.bytes.length) })
        )
      }
    } catch (error) {
      showToast(
        t('unkernelExportFailed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      setExporting(false)
    }
  }

  const exportToWorkspace = () => {
    if (!isWorkspaceEnabled()) {
      showToast(t('unkernelWorkspaceDisabled'))
      return
    }
    void runExport(true)
  }

  const statusText: Record<string, string> = {
    idle: t('unkernelStatusIdle'),
    loading: t('unkernelStatusLoading'),
    ready: workspaceMounted ? t('unkernelStatusReady') : t('unkernelStatusReadyNoWorkspace'),
    error: t('unkernelStatusError', { reason: error ?? '—' }),
  }

  return (
    <div className={nanoStyles.console}>
      <div className={nanoStyles.groupTitle}>{t('unkernelSettingsTitle')}</div>
      <div className={nanoStyles.hint}>{t('unkernelSettingsHint')}</div>

      <div className={nanoStyles.card}>
        <SwitchRow
          label={t('unkernelEnable')}
          hint={t('unkernelEnableHint')}
          checked={config.enabled}
          onChange={(enabled) => setUnkernelConfig({ enabled })}
        />
        <SwitchRow
          label={t('unkernelAllowAgent')}
          hint={t('unkernelAllowAgentHint')}
          checked={config.allowAgent && config.enabled}
          onChange={(allowAgent) => setUnkernelConfig({ allowAgent })}
        />
      </div>

      <div className={nanoStyles.groupTitle}>{t('unkernelResources')}</div>
      <div className={nanoStyles.card}>
        <div className={styles.field}>
          <div className={styles.label}>{t('unkernelDistro')}</div>
          <div className={styles.quickRow}>
            <Button
              variant={config.distro === 'alpine' ? 'primary' : 'outlined'}
              size="s"
              onClick={() => chooseDistro('alpine')}
            >
              {t('unkernelDistroAlpine')}
            </Button>
            <Button
              variant={config.distro === 'debian' ? 'primary' : 'outlined'}
              size="s"
              onClick={() => chooseDistro('debian')}
            >
              {t('unkernelDistroDebian')}
            </Button>
          </div>
          <div className={nanoStyles.hint}>{t('unkernelDistroHint')}</div>
        </div>
        <div className={nanoStyles.sliderRow}>
          <div className={nanoStyles.sliderHead}>
            <span className={nanoStyles.sliderLabel}>{t('unkernelMemory')}</span>
            <span className={nanoStyles.sliderValue}>{config.memoryMiB} MiB</span>
          </div>
          <input
            type="range"
            className={nanoStyles.range}
            min={64}
            max={2048}
            step={128}
            value={config.memoryMiB}
            aria-label={t('unkernelMemory')}
            onChange={(event) => setUnkernelConfig({ memoryMiB: Number(event.target.value) })}
          />
          <div className={nanoStyles.hint}>{t('unkernelMemoryHint')}</div>
        </div>
        <div className={nanoStyles.sliderRow}>
          <div className={nanoStyles.sliderHead}>
            <span className={nanoStyles.sliderLabel}>{t('unkernelCpu')}</span>
            <span className={nanoStyles.sliderValue}>{config.cpus}</span>
          </div>
          <input
            type="range"
            className={nanoStyles.range}
            min={1}
            max={coiState.state === 'unsupported' ? 1 : 4}
            step={1}
            value={Math.min(config.cpus, coiState.state === 'unsupported' ? 1 : 4)}
            aria-label={t('unkernelCpu')}
            onChange={(event) => chooseCpus(Number(event.target.value))}
          />
          <div className={nanoStyles.hint}>
            {coiState.state === 'isolated'
              ? t('unkernelCpuHint')
              : t('unkernelCpuRequiresCoi')}
          </div>
        </div>
        <div className={nanoStyles.switchRow}>
          <div className={nanoStyles.switchText}>
            <div className={nanoStyles.switchLabel}>{t('unkernelDisk')}</div>
            <div className={nanoStyles.hint}>{t('unkernelDiskHint')}</div>
          </div>
          <select
            className={styles.number}
            value={config.dataDiskMiB}
            aria-label={t('unkernelDisk')}
            onChange={(event) => setUnkernelConfig({ dataDiskMiB: Number(event.target.value) })}
          >
            <option value={8192} disabled={config.dataDiskMiB > 8192}>
              {t('unkernelDisk8')}
            </option>
            <option value={16384} disabled={config.dataDiskMiB > 16384}>
              {t('unkernelDisk16')}
            </option>
            <option value={32768}>{t('unkernelDisk32')}</option>
          </select>
        </div>
        <div className={nanoStyles.switchRow}>
          <div className={nanoStyles.switchText}>
            <div className={nanoStyles.switchLabel}>{t('unkernelTimeout')}</div>
            <div className={nanoStyles.hint}>{t('unkernelTimeoutHint')}</div>
          </div>
          <input
            className={styles.number}
            type="number"
            min={5}
            max={120}
            value={timeoutDraft}
            aria-label={t('unkernelTimeout')}
            onChange={(event) => setTimeoutDraft(Number(event.target.value))}
            onBlur={commitTimeout}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitTimeout()
              }
            }}
          />
        </div>
      </div>

      <div className={nanoStyles.groupTitle}>{t('unkernelFiles')}</div>
      <div className={nanoStyles.card}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="unkernel-import-dir">
            {t('unkernelImportTarget')}
          </label>
          <input
            id="unkernel-import-dir"
            className={styles.input}
            value={importDir}
            spellCheck={false}
            onChange={(event) => setImportDir(event.target.value)}
            onBlur={() => {
              const normalized = normalizeGuestPath(importDir)
              if (normalized) {
                setImportDir(normalized)
              }
            }}
          />
          <div className={nanoStyles.hint}>{t('unkernelImportTargetHint')}</div>
          <div className={styles.quickRow}>
            <Button variant="outlined" size="s" onClick={() => setImportDir('/mnt/workspace')}>
              {t('unkernelWorkspacePath')}
            </Button>
            <Button variant="outlined" size="s" onClick={() => setImportDir('/home/user')}>
              {t('unkernelHomePath')}
            </Button>
            <Button variant="outlined" size="s" onClick={() => setImportDir('/tmp')}>
              {t('unkernelTmpPath')}
            </Button>
          </div>
        </div>

        <div
          className={styles.dropZone}
          data-active={dragOver || undefined}
          data-busy={importing || undefined}
          role="button"
          tabIndex={0}
          onClick={pickFiles}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              pickFiles()
            }
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragOver(false)
            void runImport(Array.from(event.dataTransfer.files))
          }}
        >
          <div className={styles.dropTitle}>
            {importing
              ? t('unkernelImportingFile', { name: importProgress ?? '—' })
              : t('unkernelDropFiles')}
          </div>
          <div className={nanoStyles.hint}>{t('unkernelImportHint')}</div>
          <div className={styles.dropButton}>{t('unkernelChooseFiles')}</div>
        </div>
        <input
          ref={fileInput}
          className={styles.hiddenFile}
          type="file"
          multiple
          onChange={(event) => void runImport(Array.from(event.target.files ?? []))}
        />

        <SwitchRow
          label={t('unkernelImportOverwrite')}
          hint={t('unkernelImportOverwriteHint')}
          checked={overwrite}
          onChange={setOverwrite}
        />
        <div className={nanoStyles.hint}>
          {t('unkernelFileLimit', {
            import: formatBytes(MAX_IMPORT_BYTES),
            export: formatBytes(MAX_EXPORT_BYTES),
          })}
        </div>
        {importResults.length > 0 && (
          <div className={styles.fileList}>
            {importResults.map((item, index) => (
              <div className={styles.fileItem} key={`${item.name}-${index}`}>
                <span className={styles.fileName}>{item.name}</span>
                <span className={styles.fileMeta} data-error={!item.ok || undefined}>
                  {item.ok ? formatBytes(item.bytes) : item.error}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="unkernel-export-path">
            {t('unkernelExportPath')}
          </label>
          <input
            id="unkernel-export-path"
            className={styles.input}
            value={exportPath}
            spellCheck={false}
            onChange={(event) => setExportPath(event.target.value)}
            onBlur={() => {
              const normalized = normalizeGuestPath(exportPath)
              if (normalized) {
                setExportPath(normalized)
              }
            }}
          />
          <div className={nanoStyles.hint}>{t('unkernelExportHint')}</div>
          <div className={styles.quickRow}>
            <Button variant="outlined" size="s" onClick={() => setExportPath('/mnt/workspace')}>
              {t('unkernelWorkspacePath')}
            </Button>
            <Button variant="outlined" size="s" onClick={() => setExportPath('/home/user')}>
              {t('unkernelHomePath')}
            </Button>
            <Button variant="outlined" size="s" onClick={() => setExportPath('/tmp')}>
              {t('unkernelTmpPath')}
            </Button>
          </div>
          <div className={styles.actions}>
            <Button size="m" disabled={exporting} onClick={() => void runExport(false)}>
              {exporting ? t('unkernelExporting') : t('unkernelExportButton')}
            </Button>
            <Button variant="outlined" size="m" disabled={exporting} onClick={exportToWorkspace}>
              {t('unkernelExportWorkspace')}
            </Button>
          </div>
        </div>
      </div>

      <div className={nanoStyles.groupTitle}>{t('unkernelDevices')}</div>
      <div className={nanoStyles.card}>
        <SwitchRow
          label={t('unkernelNetwork')}
          hint={t('unkernelNetworkHint')}
          checked={config.network}
          onChange={(network) => setUnkernelConfig({ network })}
        />
        <SwitchRow
          label={t('unkernelSound')}
          hint={t('unkernelSoundHint')}
          checked={config.sound}
          onChange={(sound) => setUnkernelConfig({ sound })}
        />
        <SwitchRow
          label={t('unkernelDisplay')}
          hint={t('unkernelDisplayHint')}
          checked={config.display}
          onChange={(display) => setUnkernelConfig({ display })}
        />
        <SwitchRow
          label={t('unkernelPersistentData')}
          hint={t('unkernelPersistentDataHint')}
          checked={config.persistentData}
          onChange={(persistentData) => setUnkernelConfig({ persistentData })}
        />
      </div>

      <div className={nanoStyles.groupTitle}>{t('unkernelAdvanced')}</div>
      <div className={nanoStyles.card}>
        <SwitchRow
          label={t('unkernelWorker')}
          hint={t('unkernelWorkerHint')}
          checked={config.worker || config.cpus > 1}
          onChange={(worker) => setUnkernelConfig({ worker })}
        />
        <div className={styles.field}>
          <label className={styles.label} htmlFor="unkernel-wisp">
            {t('unkernelWisp')}
          </label>
          <input
            id="unkernel-wisp"
            className={styles.input}
            value={wispDraft}
            placeholder="wss://wisp.example/"
            spellCheck={false}
            onChange={(event) => setWispDraft(event.target.value)}
            onBlur={commitWisp}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitWisp()
              }
            }}
          />
          <div className={wispInvalid ? styles.invalid : nanoStyles.hint}>
            {wispInvalid ? t('unkernelWispInvalid') : t('unkernelWispHint')}
          </div>
        </div>
      </div>

      <div className={nanoStyles.groupTitle}>{t('unkernelAgentTools')}</div>
      <div className={nanoStyles.card}>
        {UNKERNEL_TOOLS.map((tool) => (
          <div className={nanoStyles.switchRow} key={tool.id}>
            <div className={nanoStyles.switchText}>
              <div className={nanoStyles.switchLabel}>{tool.label}</div>
              <div className={nanoStyles.hint}>{tool.summary}</div>
            </div>
            <span className={nanoStyles.hint}>
              {config.allowAgent ? t('unkernelToolOn') : t('unkernelToolOff')}
            </span>
          </div>
        ))}
        <div className={nanoStyles.hint}>{t('unkernelAgentToolsHint')}</div>
      </div>

      <div className={nanoStyles.groupTitle}>{t('unkernelStatusTitle')}</div>
      <div className={nanoStyles.card}>
        <div className={nanoStyles.switchRow}>
          <div className={nanoStyles.switchText}>
            <div className={nanoStyles.switchLabel}>{statusText[status] ?? statusText.idle}</div>
            <div className={nanoStyles.hint}>
              {t('unkernelWorkspaceMount', {
                state: workspaceMounted ? t('unkernelMounted') : t('unkernelNotMounted'),
              })}
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="m"
            disabled={!config.enabled}
            onClick={() => {
              openUnkernel()
              showToast({ key: 'unkernelOpening' })
            }}
          >
            {t('unkernelOpen')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            disabled={!config.enabled}
            onClick={() => {
              restartUnkernel()
              showToast(t('unkernelRestarting'))
            }}
          >
            {t('unkernelRestart')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            onClick={() => {
              resetUnkernelConfig()
              showToast({ key: 'unkernelResetDone' })
            }}
          >
            {t('unkernelReset')}
          </Button>
        </div>
        <div className={styles.note}>{t('unkernelRuntimeNote')}</div>
      </div>
    </div>
  )
}
