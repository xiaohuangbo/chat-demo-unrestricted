import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  resetAgentTools,
  setAgentToolEnabled,
  setAgentToolsEnabled,
  setAllAgentTools,
  useAgentTools,
} from '../../services/agent/agentToolSettings.js'
import { AGENT_TOOLS, agentToolSupported } from '../../services/agent/tools.js'
import { WORKSPACE_TOOLS } from '../../services/agent/workspaceTools.js'
import { setWorkspaceEnabled, useWorkspace } from '../../services/workspace/store.js'
import { useSettings } from '../../services/settings.js'
import { Switch } from '../base/Switch.js'
import { IconGenuiOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { CustomToolSetting } from './CustomToolSetting.js'
import settingsStyles from './Settings.module.css'
import styles from './AgentToolsSetting.module.css'

/**
 * 设置 → 浏览器工具。
 *
 * 主开关控制是否把工具下发给模型；下面是逐项开关，每一项都能单独关掉。
 * 浏览器能力（通知 / 定位 / 剪贴板）在部分环境下不可用，行上会标出来并禁用。
 */

type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied'

const readNotificationState = (): NotificationState => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported'
  }
  return Notification.permission as NotificationState
}

export const AgentToolsSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const enabled = useAgentTools((state) => state.enabled)
  const flags = useAgentTools((state) => state.flags)
  const [notification, setNotification] = useState<NotificationState>(readNotificationState)
  const workspaceEnabled = useWorkspace((state) => state.enabled)
  const zh = locale.startsWith('zh')

  // 通知权限可能在别处变更，切回这个分组时重新读一次
  useEffect(() => {
    setNotification(readNotificationState())
  }, [])

  const requestNotification = async () => {
    if (!('Notification' in window)) {
      showToast({ key: 'agentToolsNotifyUnsupported' })
      return
    }
    const permission = await Notification.requestPermission()
    setNotification(permission as NotificationState)
    showToast({
      key: permission === 'granted' ? 'agentToolsNotifyGranted' : 'agentToolsNotifyDenied',
    })
  }

  return (
    <>
      <div className={settingsStyles.groupTitle}>{t('agentToolsSectionTitle')}</div>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('agentToolsMasterLabel')}</div>
          <div className={settingsStyles.description}>{t('agentToolsMasterDesc')}</div>
        </div>
        <Switch
          checked={enabled}
          onChange={setAgentToolsEnabled}
          label={t('agentToolsMasterLabel')}
        />
      </div>

      <div className={styles.actions}>
        <Button
          size="s"
          variant="outlined"
          onClick={() => {
            setAgentToolsEnabled(true)
            setAllAgentTools(true)
          }}
        >
          {t('agentToolsEnableAll')}
        </Button>
        <Button size="s" variant="outlined" onClick={() => setAllAgentTools(false)}>
          {t('agentToolsDisableAll')}
        </Button>
        <Button
          size="s"
          variant="outlined"
          onClick={() => {
            resetAgentTools()
            showToast({ key: 'agentToolsResetDone' })
          }}
        >
          {t('agentToolsReset')}
        </Button>
      </div>

      <div className={styles.capabilities}>
        <span className={styles.capability} data-ok={notification === 'granted' || undefined}>
          {t('agentToolsCapNotify')}：{t(`agentToolsNotify_${notification}`)}
        </span>
        <span className={styles.capability}>
          {t('agentToolsCapClipboard')}：
          {t(
            typeof navigator !== 'undefined' && navigator.clipboard
              ? 'agentToolsCapAvailable'
              : 'agentToolsCapUnavailable'
          )}
        </span>
        <span className={styles.capability}>
          {t('agentToolsCapLocation')}：
          {t('geolocation' in navigator ? 'agentToolsCapAvailable' : 'agentToolsCapUnavailable')}
        </span>
        {notification === 'default' ? (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void requestNotification()}
          >
            {t('agentToolsNotifyRequest')}
          </button>
        ) : null}
      </div>

      <div className={settingsStyles.groupTitle}>{t('agentToolsListTitle')}</div>
      <div className={styles.list}>
        {AGENT_TOOLS.map((tool) => {
          const supported = agentToolSupported(tool)
          const checked = enabled && flags[tool.id] !== false
          const label = zh ? tool.label : tool.labelEn
          const summary = zh ? tool.summary : tool.summaryEn
          return (
            <div
              key={tool.id}
              className={styles.tool}
              data-off={!supported || undefined}
              data-enabled={checked || undefined}
            >
              <div className={styles.toolText}>
                <div className={styles.toolHead}>
                  {tool.id === 'show_genui' ? (
                    <span className={styles.toolIcon} aria-hidden>
                      <IconGenuiOutline16 />
                    </span>
                  ) : null}
                  <span className={styles.toolLabel}>{label}</span>
                  {tool.requiresApproval ? (
                    <span className={styles.chip} data-tone="confirm">
                      {t('agentToolsChipConfirm')}
                    </span>
                  ) : null}
                  <span className={styles.chip} data-tone={tool.risk}>
                    {t(`agentToolsRisk_${tool.risk}`)}
                  </span>
                  {!supported ? (
                    <span className={styles.chip} data-tone="off">
                      {t('agentToolsChipUnsupported')}
                    </span>
                  ) : null}
                </div>
                <div className={styles.toolSummary}>{summary}</div>
              </div>
              <Switch
                checked={checked}
                disabled={!supported || !enabled}
                onChange={(value) => setAgentToolEnabled(tool.id, value)}
                label={label}
              />
            </div>
          )
        })}
      </div>
      <div className={styles.note}>{t('agentToolsFootnote')}</div>

      <CustomToolSetting />

      <div className={settingsStyles.groupTitle}>{t('agentWorkspaceToolsTitle')}</div>
      <div className={styles.workspaceGate}>
        <div className={styles.workspaceGateText}>
          <div className={styles.workspaceGateLabel}>{t('agentWorkspaceGateLabel')}</div>
          <div className={styles.workspaceGateDesc}>{t('agentWorkspaceGateDesc')}</div>
        </div>
        <Switch
          checked={workspaceEnabled}
          onChange={setWorkspaceEnabled}
          label={t('agentWorkspaceGateLabel')}
        />
      </div>
      <div className={styles.list}>
        {WORKSPACE_TOOLS.map((tool) => {
          const checked = workspaceEnabled && enabled && flags[tool.id] !== false
          const label = zh ? tool.label : tool.labelEn
          const summary = zh ? tool.summary : tool.summaryEn
          return (
            <div
              key={tool.id}
              className={styles.tool}
              data-off={!workspaceEnabled || undefined}
              data-enabled={checked || undefined}
            >
              <div className={styles.toolText}>
                <div className={styles.toolHead}>
                  <span className={styles.toolLabel}>{label}</span>
                  {tool.requiresApproval ? (
                    <span className={styles.chip} data-tone="confirm">
                      {t('agentToolsChipConfirm')}
                    </span>
                  ) : null}
                  <span className={styles.chip} data-tone={tool.risk}>
                    {t(`agentToolsRisk_${tool.risk}`)}
                  </span>
                  {!workspaceEnabled ? (
                    <span className={styles.chip} data-tone="off">
                      {t('agentWorkspaceChipOff')}
                    </span>
                  ) : null}
                </div>
                <div className={styles.toolSummary}>{summary}</div>
              </div>
              <Switch
                checked={checked}
                disabled={!workspaceEnabled || !enabled}
                onChange={(value) => setAgentToolEnabled(tool.id, value)}
                label={label}
              />
            </div>
          )
        })}
      </div>
      <div className={styles.note}>{t('agentWorkspaceToolsNote')}</div>
    </>
  )
}
