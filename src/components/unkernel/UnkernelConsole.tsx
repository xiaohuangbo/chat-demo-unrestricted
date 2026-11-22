import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import {
  resetUnkernelConfig,
  setUnkernelConfig,
  useUnkernelConfig,
} from '../../services/unkernel/config.js'
import { openUnkernel, useUnkernel } from '../../services/unkernel/session.js'
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

  const commitTimeout = () => {
    const seconds = Number(timeoutDraft)
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) {
      setTimeoutDraft(Math.round(config.timeoutMs / 1000))
      return
    }
    setUnkernelConfig({ timeoutMs: Math.round(seconds) * 1000 })
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
        <div className={nanoStyles.sliderRow}>
          <div className={nanoStyles.sliderHead}>
            <span className={nanoStyles.sliderLabel}>{t('unkernelMemory')}</span>
            <span className={nanoStyles.sliderValue}>{config.memoryMiB} MiB</span>
          </div>
          <input
            type="range"
            className={nanoStyles.range}
            min={64}
            max={1024}
            step={64}
            value={config.memoryMiB}
            aria-label={t('unkernelMemory')}
            onChange={(event) => setUnkernelConfig({ memoryMiB: Number(event.target.value) })}
          />
          <div className={nanoStyles.hint}>{t('unkernelMemoryHint')}</div>
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
          checked={config.worker}
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
