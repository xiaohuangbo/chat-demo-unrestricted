import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import { loadEngine, resetEngine, useEngine } from '../../services/nanovm/boot.js'
import {
  DISK_MAX_MB,
  DISK_MIN_MB,
  MEMORY_MAX_MB,
  MEMORY_MIN_MB,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  setNanoVMAllowAgent,
  setNanoVMConfig,
  setNanoVMEnabled,
  useNanoVMConfig,
} from '../../services/nanovm/config.js'
import { vmFs } from '../../services/nanovm/fs.js'
import {
  importLocalFileToVm,
  importWorkspaceFileToVm,
  VmImportError,
  vmFileLimitMB,
} from '../../services/nanovm/importFile.js'
import { hydrateWorkspace, useWorkspace } from '../../services/workspace/store.js'
import { NetError, fetchNet, netStatus, type NetRoute } from '../../services/nanovm/netProxy.js'
import {
  TOOLCHAIN_CATEGORIES,
  TOOLCHAIN_IDS,
  installToolchain,
  toolchainHint,
  toolchainIdsByCategory,
  uninstallToolchain,
  usePackages,
} from '../../services/nanovm/packages.js'
import { openNanoVM, resetNanoVMSession } from '../../services/nanovm/session.js'
import type { ToolchainCategory, ToolchainId, ToolchainState } from '../../services/nanovm/types.js'
import { closeSettings } from '../settings/settingsDialogState.js'
import { mbText, useVmUsage } from './usage.js'
import styles from './NanoVM.module.css'

/** 单行开关：左侧文案 + 右侧方块开关 */
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
  <div className={styles.switchRow}>
    <div className={styles.switchText}>
      <div className={styles.switchLabel}>{label}</div>
      <div className={styles.hint}>{hint}</div>
    </div>
    <Switch checked={checked} onChange={onChange} label={label} />
  </div>
)

/** 配额滑块：数值显示在标题右侧，说明放在滑块下面 */
const SliderRow = ({
  label,
  hint,
  display,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  hint: string
  display: string
  value: number
  min: number
  max: number
  step: number
  onChange: (next: number) => void
}) => (
  <div className={styles.sliderRow}>
    <div className={styles.sliderHead}>
      <span className={styles.sliderLabel}>{label}</span>
      <span className={styles.sliderValue}>{display}</span>
    </div>
    <input
      type="range"
      className={styles.range}
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    />
    <div className={styles.hint}>{hint}</div>
  </div>
)

/** 联网代理：自动 / 直连 / 自定义，带一条连通性测试 */
const NetCard = () => {
  const t = useTranslate()
  const netMode = useNanoVMConfig((state) => state.netMode)
  const proxyUrl = useNanoVMConfig((state) => state.proxyUrl)
  const [draft, setDraft] = useState(proxyUrl)
  const [invalid, setInvalid] = useState(false)
  const [checking, setChecking] = useState(false)

  // 提交后（或别处改了地址）把输入框同步成落盘值
  useEffect(() => {
    setDraft(proxyUrl)
  }, [proxyUrl])

  const status = netStatus()
  const detail =
    status.route === 'native'
      ? t('nanovmNetNative')
      : status.route === 'custom'
        ? t('nanovmNetCustomStatus', { url: proxyUrl })
        : status.route === 'off'
          ? t('nanovmNetCustomEmpty')
          : t('nanovmNetNativeOff')

  const routeLabel = (route: NetRoute): string =>
    route === 'native'
      ? t('nanovmNetNative')
      : route === 'custom'
        ? t('nanovmNetCustom')
        : t('nanovmNetNativeOff')

  /** 失焦 / 回车提交：空值等于清空，非空必须以 http(s):// 开头 */
  const commit = () => {
    const value = draft.trim()
    if (value && !/^https?:\/\//i.test(value)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setNanoVMConfig({ proxyUrl: value })
  }

  const check = async () => {
    setChecking(true)
    const started = performance.now()
    try {
      // api.github.com 带 Access-Control-Allow-Origin: *，浏览器直连也能成功
      const result = await fetchNet('api.github.com', { method: 'HEAD', timeoutMs: 8000 })
      showToast({
        key: 'nanovmNetCheckOk',
        params: {
          status: result.status,
          ms: Math.round(performance.now() - started),
          route: routeLabel(result.route),
        },
      })
    } catch (error) {
      const reason =
        error instanceof NetError
          ? (error.hint ?? error.message)
          : error instanceof Error
            ? error.message
            : String(error)
      showToast({ key: 'nanovmNetCheckFail', params: { reason }, type: 'error' })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className={styles.card} data-section="net">
      <div className={styles.netHead}>
        <div className={styles.actionLabel}>{t('nanovmNet')}</div>
        <div className={styles.hint}>{t('nanovmNetHint')}</div>
      </div>
      <div className={styles.netControl}>
        <Select
          value={netMode}
          ariaLabel={t('nanovmNet')}
          options={[
            { value: 'auto', label: t('nanovmNetAuto') },
            { value: 'direct', label: t('nanovmNetDirect') },
            { value: 'custom', label: t('nanovmNetCustom') },
          ]}
          onChange={(mode) => setNanoVMConfig({ netMode: mode })}
        />
      </div>
      {netMode === 'custom' ? (
        <>
          <input
            className={styles.netInput}
            value={draft}
            placeholder={t('nanovmNetPlaceholder')}
            aria-label={t('nanovmNetCustom')}
            aria-invalid={invalid || undefined}
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value)
              setInvalid(false)
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              }
            }}
          />
          {/* 地址格式不对：红边 + 一行红字 */}
          {invalid ? <div className={styles.error}>{t('nanovmNetInvalid')}</div> : null}
        </>
      ) : null}
      <div className={styles.netStatus}>{t('nanovmNetStatus', { detail })}</div>
      <div className={styles.netActions}>
        <Button
          size="s"
          variant="outlined"
          disabled={checking}
          aria-busy={checking}
          onClick={() => void check()}
        >
          {checking ? t('nanovmNetChecking') : t('nanovmNetCheck')}
        </Button>
        {checking ? <span className={styles.spinner} aria-hidden /> : null}
      </div>
      <div className={styles.netNote}>{t('nanovmNetPingHint')}</div>
    </div>
  )
}

/** 分组标题文案键：运行时 / 构建工具 / 命令行工具 */
const categoryTitle = (category: ToolchainCategory): TranslationKey =>
  category === 'runtime'
    ? 'nanovmToolchainsRuntime'
    : category === 'build'
      ? 'nanovmToolchainsBuild'
      : 'nanovmToolchainsTool'

/** 每组标题下的一句话说明文案键 */
const categoryHint = (category: ToolchainCategory): TranslationKey =>
  category === 'runtime'
    ? 'nanovmToolchainsRuntimeHint'
    : category === 'build'
      ? 'nanovmToolchainsBuildHint'
      : 'nanovmToolchainsToolHint'

/** 体积文案：整数按 12 MB 显示，0.4 / 1.3 这种小数保留一位 */
const sizeText = (sizeMB: number): string =>
  `${Number.isInteger(sizeMB) ? sizeMB : sizeMB.toFixed(1)} MB`

/**
 * 单张工具链卡片。
 *
 * 信息自上而下：名称 + 体积徽标 + 状态点、一句话说明、版本 / 未安装、示例命令（已安装时
 * 可点击复制）与操作按钮；安装中显示百分比与进度条，失败时显示原因。
 *
 * 安装是全局串行的（store 里只有一个 busy），所以别的卡片在装时按钮也要一起禁用；
 * 本地的 pending 覆盖「刚点下去、store 还没置忙」的那一瞬间。
 */
const ToolchainCard = ({
  state,
  busyId,
}: {
  state: ToolchainState
  busyId: ToolchainId | null
}) => {
  const t = useTranslate()
  // 本地动作：覆盖「刚点下去、store 还没置忙」的那一瞬间，并区分装 / 卸
  const [pending, setPending] = useState<'install' | 'uninstall' | null>(null)
  const active = busyId === state.id || pending === 'install'
  const locked = busyId !== null || pending !== null
  const percent = Math.round(Math.min(1, Math.max(0, state.progress ?? 0)) * 100)
  // sizeMB 为 0 的是内置运行时：按钮语义从「安装 / 卸载」换成「启用 / 停用」
  const builtin = state.sizeMB === 0
  const hint = toolchainHint(state.id)
  // 非安全上下文或老浏览器可能没有剪贴板 API：这时只展示命令，不做成可点
  const canCopy =
    typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'

  const copyHint = async () => {
    try {
      await navigator.clipboard.writeText(hint)
      showToast({ key: 'nanovmToolchainCopied' })
    } catch {
      // 权限被拒（没给剪贴板授权）时退回提示，避免看起来像复制成功了
      showToast({ key: 'nanovmToolchainCopyFailed', type: 'error' })
    }
  }

  const install = async () => {
    setPending('install')
    try {
      const result = await installToolchain(state.id)
      if (result.ok) {
        // 安装完不重置虚拟机：运行时是懒加载的，下一条命令自然用上新的
        showToast({ key: 'nanovmInstalledToast', params: { label: state.label } })
      } else {
        showToast({
          key: 'nanovmInstallFailed',
          params: { reason: result.error ?? state.label },
          type: 'error',
        })
      }
    } catch (error) {
      // installToolchain 自己会兜住下载失败；真抛出来也别让异常静默丢掉
      showToast({
        key: 'nanovmInstallFailed',
        params: { reason: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    } finally {
      setPending(null)
    }
  }

  const remove = async () => {
    setPending('uninstall')
    try {
      await uninstallToolchain(state.id)
      showToast({ key: 'nanovmUninstalledToast', params: { label: state.label } })
    } catch (error) {
      showToast({
        key: 'nanovmUninstallFailed',
        params: { reason: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    } finally {
      setPending(null)
    }
  }

  return (
    <div className={styles.toolchain} data-toolchain={state.id} data-installed={state.installed}>
      <div className={styles.toolchainHead}>
        <span className={styles.toolchainName}>{state.label}</span>
        <span className={styles.toolchainMeta}>
          <span className={styles.toolchainSize}>
            {builtin ? t('nanovmBuiltinLabel') : sizeText(state.sizeMB)}
          </span>
          {/* 状态点：已安装绿、未安装灰，复用 ShellDock 的状态点样式 */}
          <span
            className={styles.statusDot}
            data-status={state.installed ? 'ready' : 'idle'}
            aria-hidden
          />
        </span>
      </div>
      <div className={styles.hint}>{state.summary}</div>
      <div className={styles.toolchainState}>
        {state.installed
          ? t('nanovmInstalledVersion', { version: state.version || '—' })
          : t('nanovmNotInstalled')}
      </div>
      {/* 已安装才给示例命令；可点击复制到剪贴板，没有剪贴板 API 时只展示 */}
      {state.installed ? (
        canCopy ? (
          <button
            type="button"
            className={styles.toolchainTry}
            title={t('nanovmToolchainCopy')}
            aria-label={`${t('nanovmToolchainCopy')}: ${t('nanovmToolchainTryHint', { command: hint })}`}
            onClick={() => void copyHint()}
          >
            {t('nanovmToolchainTryHint', { command: hint })}
          </button>
        ) : (
          // 没有剪贴板 API 的浏览器：同样的样式，但只展示不可点
          <div className={styles.toolchainTry} data-static="true">
            {t('nanovmToolchainTryHint', { command: hint })}
          </div>
        )
      ) : null}
      {active ? (
        <>
          <div className={styles.toolchainState}>{t('nanovmInstalling', { percent })}</div>
          <div className={styles.toolchainBar} aria-hidden>
            <span style={{ width: `${percent}%` }} />
          </div>
        </>
      ) : null}
      {/* 失败原因由 packages 侧写好，直接显示，不再套一层「安装失败」 */}
      {state.error ? <div className={styles.error}>{state.error}</div> : null}
      <div className={styles.toolchainActions}>
        {state.installed ? (
          <Button size="s" variant="outlined" disabled={locked} onClick={() => void remove()}>
            {builtin ? t('nanovmInstallDisable') : t('nanovmUninstall')}
          </Button>
        ) : (
          <Button size="s" disabled={locked} onClick={() => void install()}>
            {builtin ? t('nanovmInstallEnable') : t('nanovmInstallNow')}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * 设置 → NanoVM Slim 控制台。
 *
 * 开关与资源配额、引擎与存储状态、虚拟机镜像的导入导出与重置、按需工具链，
 * 最后是「打开终端」。改内存 / 磁盘会重新分配 WASM 线性内存，所以顺手
 * resetEngine()，下一次执行命令时按新配额重建。
 */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const NanoVMConsole = () => {
  const t = useTranslate()
  const enabled = useNanoVMConfig((state) => state.enabled)
  const allowAgent = useNanoVMConfig((state) => state.allowAgent)
  const autoLoad = useNanoVMConfig((state) => state.autoLoad)
  const desktopDock = useNanoVMConfig((state) => state.desktopDock)
  const memoryMB = useNanoVMConfig((state) => state.memoryMB)
  const diskMB = useNanoVMConfig((state) => state.diskMB)
  const timeoutMs = useNanoVMConfig((state) => state.timeoutMs)
  const engineStatus = useEngine((state) => state.status)
  const engineInfo = useEngine((state) => state.info)
  const engineError = useEngine((state) => state.error)
  const usage = useVmUsage()
  const packages = usePackages((state) => state.states)
  const busy = usePackages((state) => state.busy)

  const [mergeMode, setMergeMode] = useState<'merge' | 'replace'>('merge')
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const [fileImporting, setFileImporting] = useState(false)
  const [targetDir, setTargetDir] = useState('/home/user')
  const [overwrite, setOverwrite] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const workspaceFiles = useWorkspace((state) => state.files)
  const workspaceHydrated = useWorkspace((state) => state.hydrated)

  const timeoutSeconds = Math.round(timeoutMs / 1000)
  const storageOpfs = vmFs.usage().opfs
  const usedPercent = Math.min(
    100,
    Math.round((usage.bytes / Math.max(1, usage.diskMB * 1024 * 1024)) * 100)
  )
  // 工具链总结：已安装个数 + 需要下载的那部分占用（内置的不计体积）
  const installedTotals = TOOLCHAIN_IDS.reduce(
    (acc, id) => ({
      count: acc.count + (packages[id].installed ? 1 : 0),
      diskMB:
        acc.diskMB + (packages[id].installed && packages[id].sizeMB > 0 ? packages[id].sizeMB : 0),
    }),
    { count: 0, diskMB: 0 }
  )
  const diskText = Number.isInteger(installedTotals.diskMB)
    ? String(installedTotals.diskMB)
    : installedTotals.diskMB.toFixed(1)

  /** 改配额：立刻落盘，引擎下一次执行命令时按新配额重建线性内存 */
  const applyQuota = (patch: { memoryMB: number } | { diskMB: number }) => {
    setNanoVMConfig(patch)
    resetEngine()
    showToast({ key: 'nanovmApplyNext' })
  }

  const exportImage = async () => {
    setExporting(true)
    try {
      const blob = await vmFs.exportImage()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'nanovm-slim.zip'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showToast({ key: 'nanovmExportDone' })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(false)
    }
  }

  const importImage = async (file: File) => {
    setImporting(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const count = await vmFs.importImage(bytes, mergeMode)
      showToast({ key: 'nanovmImportDone', params: { count } })
    } catch (error) {
      showToast({
        key: 'nanovmImportFailed',
        params: { reason: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    } finally {
      setImporting(false)
    }
  }

  const importSingleFile = async (file: File) => {
    setFileImporting(true)
    try {
      const result = await importLocalFileToVm(file, { targetDir, overwrite })
      if (result.grownTo) {
        showToast({
          key: 'nanovmFileImportGrown',
          params: { path: result.path, size: formatBytes(result.bytes), disk: result.grownTo },
        })
      } else {
        showToast({
          key: 'nanovmFileImportDone',
          params: { path: result.path, size: formatBytes(result.bytes) },
        })
      }
    } catch (error) {
      showToast({
        key: 'nanovmFileImportFailed',
        params: {
          reason:
            error instanceof VmImportError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
        },
        type: 'error',
      })
    } finally {
      setFileImporting(false)
    }
  }

  const importWorkspace = async (workspacePath: string) => {
    setFileImporting(true)
    try {
      const result = await importWorkspaceFileToVm(workspacePath, { targetDir, overwrite })
      setWorkspaceOpen(false)
      if (result.grownTo) {
        showToast({
          key: 'nanovmFileImportGrown',
          params: { path: result.path, size: formatBytes(result.bytes), disk: result.grownTo },
        })
      } else {
        showToast({
          key: 'nanovmFileImportDone',
          params: { path: result.path, size: formatBytes(result.bytes) },
        })
      }
    } catch (error) {
      showToast({
        key: 'nanovmFileImportFailed',
        params: {
          reason:
            error instanceof VmImportError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
        },
        type: 'error',
      })
    } finally {
      setFileImporting(false)
    }
  }

  const openWorkspacePicker = async () => {
    setWorkspaceOpen(true)
    if (!workspaceHydrated) {
      setWorkspaceBusy(true)
      try {
        await hydrateWorkspace()
      } finally {
        setWorkspaceBusy(false)
      }
    }
  }

  const resetAll = async () => {
    setResetting(true)
    try {
      await vmFs.reset()
      resetNanoVMSession()
      resetEngine()
      showToast({ key: 'nanovmResetDone' })
      setConfirmReset(false)
    } finally {
      setResetting(false)
    }
  }

  const engineText =
    engineStatus === 'ready' && engineInfo
      ? t('nanovmEngineReady', { memory: engineInfo.wasmMemoryMB, ms: engineInfo.bootMs })
      : engineStatus === 'loading'
        ? t('nanovmStatusLoading')
        : engineStatus === 'error'
          ? t('nanovmStatusError', { reason: engineError ?? '—' })
          : t('nanovmEngineIdle')

  return (
    <div className={styles.console}>
      <div className={styles.groupTitle}>{t('nanovmConsoleTitle')}</div>

      <div className={styles.card}>
        <SwitchRow
          label={t('nanovmEnable')}
          hint={t('nanovmEnableHint')}
          checked={enabled}
          onChange={setNanoVMEnabled}
        />
        <SwitchRow
          label={t('nanovmAllowAgent')}
          hint={t('nanovmAllowAgentHint')}
          checked={allowAgent}
          onChange={setNanoVMAllowAgent}
        />
        <SwitchRow
          label={t('nanovmAutoLoad')}
          hint={t('nanovmAutoLoadHint')}
          checked={autoLoad}
          onChange={(next) => setNanoVMConfig({ autoLoad: next })}
        />
        <SwitchRow
          label={t('nanovmDesktopDock')}
          hint={t('nanovmDesktopDockHint')}
          checked={desktopDock}
          onChange={(next) => setNanoVMConfig({ desktopDock: next })}
        />
      </div>

      <div className={styles.card}>
        <SliderRow
          label={t('nanovmMemory')}
          hint={t('nanovmMemoryHint')}
          display={t('nanovmMemoryValue', { value: memoryMB })}
          value={memoryMB}
          min={MEMORY_MIN_MB}
          max={MEMORY_MAX_MB}
          step={32}
          onChange={(value) => applyQuota({ memoryMB: value })}
        />
        <SliderRow
          label={t('nanovmDisk')}
          hint={t('nanovmDiskHint')}
          display={t('nanovmMemoryValue', { value: diskMB })}
          value={diskMB}
          min={DISK_MIN_MB}
          max={DISK_MAX_MB}
          step={16}
          onChange={(value) => applyQuota({ diskMB: value })}
        />
        <SliderRow
          label={t('nanovmTimeout')}
          hint={t('nanovmTimeoutHint')}
          display={t('nanovmTimeoutValue', { value: timeoutSeconds })}
          value={timeoutSeconds}
          min={TIMEOUT_MIN_MS / 1000}
          max={TIMEOUT_MAX_MS / 1000}
          step={1}
          onChange={(value) => setNanoVMConfig({ timeoutMs: value * 1000 })}
        />
      </div>

      <NetCard />

      <div className={styles.card}>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>{t('nanovmEngine')}</span>
          <span className={styles.statValue} data-status={engineStatus}>
            {engineText}
          </span>
          {engineStatus === 'error' ? (
            <Button size="s" variant="outlined" onClick={() => void loadEngine()}>
              {t('nanovmRetry')}
            </Button>
          ) : null}
        </div>
        {/* 引擎没加载时没有命令数可显示，别写成「0 个内置命令」 */}
        {engineInfo ? (
          <div className={styles.statLine}>{t('nanovmApplets', { count: engineInfo.applets })}</div>
        ) : null}
        <div className={styles.usageBlock}>
          <div className={styles.usageText}>
            {t('nanovmUsage', {
              files: usage.files,
              used: mbText(usage.bytes),
              total: usage.diskMB,
            })}
          </div>
          <div className={styles.usageBar} aria-hidden>
            <span style={{ width: `${usedPercent}%` }} />
          </div>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>{t('nanovmStorage')}</span>
          <span className={styles.statValue}>
            {t(storageOpfs ? 'nanovmStorageOpfs' : 'nanovmStorageLocal')}
          </span>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.actionRow}>
          <div className={styles.actionText}>
            <div className={styles.actionLabel}>{t('nanovmFileImport')}</div>
            <div className={styles.hint}>{t('nanovmFileImportHint')}</div>
          </div>
          <div className={styles.fileImportActions}>
            <Button
              size="s"
              variant="outlined"
              disabled={fileImporting}
              onClick={() => fileRef.current?.click()}
            >
              {t('nanovmImportLocal')}
            </Button>
            <Button
              size="s"
              variant="outlined"
              disabled={fileImporting}
              onClick={() => void openWorkspacePicker()}
            >
              {t('nanovmImportWorkspace')}
            </Button>
          </div>
        </div>
        <div className={styles.fileImportForm}>
          <label className={styles.fileImportField}>
            <span>{t('nanovmImportTarget')}</span>
            <input
              value={targetDir}
              spellCheck={false}
              aria-label={t('nanovmImportTarget')}
              onChange={(event) => setTargetDir(event.target.value)}
            />
          </label>
          <div className={styles.fileImportToggle}>
            <span>{t('nanovmImportOverwrite')}</span>
            <Switch
              checked={overwrite}
              onChange={setOverwrite}
              label={t('nanovmImportOverwrite')}
            />
          </div>
        </div>
        <div className={styles.hint}>
          {t('nanovmImportTargetHint')} · {t('nanovmFileLimit', { limit: vmFileLimitMB() })}
        </div>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void importSingleFile(file)
            }
          }}
        />
      </div>

      <div className={styles.card}>
        <div className={styles.actionRow}>
          <div className={styles.actionText}>
            <div className={styles.actionLabel}>{t('nanovmExportImage')}</div>
            <div className={styles.hint}>{t('nanovmExportHint')}</div>
          </div>
          <Button
            size="s"
            variant="outlined"
            disabled={exporting}
            onClick={() => void exportImage()}
          >
            {t('nanovmExportImage')}
          </Button>
        </div>
        <div className={styles.actionRow}>
          <div className={styles.actionText}>
            <div className={styles.actionLabel}>{t('nanovmImportImage')}</div>
            <div className={styles.modeTabs} role="tablist" aria-label={t('nanovmImportMode')}>
              {(['merge', 'replace'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={mergeMode === mode}
                  className={clsx(styles.modeTab, mergeMode === mode && styles.modeTabActive)}
                  onClick={() => setMergeMode(mode)}
                >
                  {t(mode === 'merge' ? 'nanovmMerge' : 'nanovmReplace')}
                </button>
              ))}
            </div>
          </div>
          <Button
            size="s"
            variant="outlined"
            disabled={importing}
            onClick={() => importRef.current?.click()}
          >
            {t('nanovmImportImage')}
          </Button>
        </div>
        <div className={styles.actionRow}>
          <div className={styles.actionText}>
            <div className={styles.actionLabel}>{t('nanovmReset')}</div>
            <div className={styles.hint}>{t('nanovmResetHint')}</div>
          </div>
          <Button
            size="s"
            variant="dangerOutlined"
            disabled={resetting}
            onClick={() => setConfirmReset(true)}
          >
            {t('nanovmReset')}
          </Button>
        </div>
        <input
          ref={importRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void importImage(file)
            }
          }}
        />
      </div>

      <div className={styles.groupTitle}>{t('nanovmToolchains')}</div>
      <div className={styles.sectionHint}>{t('nanovmToolchainsHint')}</div>
      {/* 总结行：已安装 N / 总数 M，占用约 X MB */}
      <div className={styles.toolchainTotals}>
        {t('nanovmToolchainSummary', {
          installed: installedTotals.count,
          total: TOOLCHAIN_IDS.length,
          size: diskText,
        })}
      </div>
      {/* 按分组渲染：运行时 / 构建工具 / 命令行工具，组内顺序由注册表决定 */}
      {TOOLCHAIN_CATEGORIES.map((category) => (
        <div key={category} className={styles.toolchainGroup} data-category={category}>
          <div className={styles.groupTitle}>{t(categoryTitle(category))}</div>
          <div className={styles.sectionHint}>{t(categoryHint(category))}</div>
          <div className={styles.toolchains}>
            {toolchainIdsByCategory(category).map((id) => (
              <ToolchainCard key={id} state={packages[id]} busyId={busy} />
            ))}
          </div>
        </div>
      ))}

      <div className={styles.footer}>
        <Button
          block
          disabled={!enabled}
          onClick={() => {
            openNanoVM()
            closeSettings()
          }}
        >
          {t('nanovmOpenTerminal')}
        </Button>
      </div>

      {confirmReset ? (
        <Modal
          title={t('nanovmReset')}
          onClose={() => setConfirmReset(false)}
          className={styles.confirm}
          footer={
            <div className={styles.confirmActions}>
              <Button variant="outlined" onClick={() => setConfirmReset(false)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={resetting} onClick={() => void resetAll()}>
                {t('nanovmReset')}
              </Button>
            </div>
          }
        >
          {t('nanovmResetConfirm')}
        </Modal>
      ) : null}

      {workspaceOpen ? (
        <Modal
          title={t('nanovmWorkspacePick')}
          onClose={() => setWorkspaceOpen(false)}
          className={styles.confirm}
          footer={
            <div className={styles.confirmActions}>
              <Button variant="outlined" onClick={() => setWorkspaceOpen(false)}>
                {t('cancel')}
              </Button>
            </div>
          }
        >
          {workspaceBusy ? (
            <div className={styles.hint}>{t('nanovmWorkspaceLoading')}</div>
          ) : Object.keys(workspaceFiles).length === 0 ? (
            <div className={styles.hint}>{t('nanovmWorkspaceEmpty')}</div>
          ) : (
            <div className={styles.workspaceList}>
              {Object.values(workspaceFiles)
                .slice()
                .sort((left, right) => right.updatedAt - left.updatedAt)
                .map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className={styles.workspaceRow}
                    disabled={fileImporting}
                    onClick={() => void importWorkspace(file.path)}
                  >
                    <span className={styles.workspaceName}>{file.path}</span>
                    <span className={styles.workspaceMeta}>
                      {t('nanovmWorkspaceFileMeta', { size: formatBytes(file.size) })}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  )
}
