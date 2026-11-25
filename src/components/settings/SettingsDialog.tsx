import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconBranchOutline16,
  IconBrowseOutline16,
  IconCustomCotOutline16,
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconLinkOutline16,
  IconPaperclipOutline16,
  IconRefreshOutline16,
  IconSearchWarningOutline16,
  IconChartOutline16,
  IconChipOutline16,
  IconRobotOutline16,
  IconWalletOutline16,
  IconSettingsOutline16,
  IconTerminalOutline16,
  IconThinkOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  type ImportProgress,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { modelLabel } from '../../services/api/models.js'
import { MemorySettings } from './MemorySettings.js'
import { SearchPoisonSettings } from './SearchPoisonSettings.js'
import { AttachmentPoisonSettings } from './AttachmentPoisonSettings.js'
import { LARGE_TEXT_TOKEN_LIMIT } from '../../services/attachmentLargeText.js'
import { useChatStore } from '../../services/chat/store.js'
import {
  regionCodes,
  getRegionName,
  provinces,
  specialPlaces,
  type SpecialPlace,
} from '../../services/location.js'
import {
  isChineseBrowser,
  resetSettings,
  CUSTOM_COT_MAX_CHARS,
  setAttachmentExts,
  setAutoJailbreak,
  setAttachmentLargeText,
  setAttachmentLargeTextInline,
  setAttachmentLimits,
  setAttachmentMaxCount,
  setAttachmentMaxMB,
  setAutoCompress,
  setAutoTune,
  setCompressThreshold,
  setAutoTuneStrategy,
  setCustomCot,
  setCustomCotEnabled,
  setInjectPromptEveryTurn,
  setContinueRefused,
  setRefusalCaseSensitive,
  setRefusalEnabled,
  setRefusalKeywords,
  setRefusalMessage,
  setDailyCostLimit,
  setDailyLimitEnabled,
  setDailyTokenLimit,
  setParseltongue,
  setParseltongueIntensity,
  setParseltongueTechnique,
  setPromptPreset,
  setStmModules,
  setStreamOutput,
  setThinkingAsBody,
  setTranslateJailbreakZh,
  setKeepReplyContent,
  setLocale,
  setLocation,
  setMaxTokens,
  setSkipSafetyCheck,
  setSystemPrompt,
  setTemperature,
  setThemePreference,
  setTopP,
  setTtsVoice,
  setUnrestricted,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import {
  resetDailyUsage,
  syncDailyUsageDate,
  useDailyUsage,
} from '../../services/chat/dailyUsage.js'
import { formatMoney, formatTokens } from '../../services/chat/sessionStats.js'
import type { AutoTuneStrategy } from '../../services/unrestricted/autotune.js'
import type { ObfuscationTechnique } from '../../services/unrestricted/parseltongue.js'
import type { PromptPreset } from '../../services/unrestricted/prompts.js'
import { useFeedback } from '../../services/chat/feedbackStore.js'
import { composeSystemPrompt } from '../../services/chat/systemPrompt.js'
import { formatCustomCotContext } from '../../services/chat/customCot.js'
import { DEFAULT_CUSTOM_COT } from '../../services/chat/defaultCot.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import { ParamControl } from './ParamControls.js'
import { StatsSettings } from './StatsSettings.js'
import { AgentToolsSetting } from './AgentToolsSetting.js'
import { WorkspaceSetting } from './WorkspaceSetting.js'
import { UpdateCard } from './UpdateCard.js'
import { NanoVMConsole } from '../nanovm/NanoVMConsole.js'
import { WebVMConsole } from '../webvm/WebVMConsole.js'
import { UnkernelConsole } from '../unkernel/UnkernelConsole.js'
import { LocalModelSettings } from '../local/LocalModelSettings.js'
import { RolesSettings } from './RolesSettings.js'
import { AccountSettings } from './AccountSettings.js'
import { ProfileCard } from './ProfileCard.js'
import { PromptPresetBar } from './PromptPresetBar.js'
import {
  ensurePromptPresetsMigrated,
  resetPromptPresets,
  updatePresetContent,
  usePromptPresets,
} from '../../services/promptPresets.js'
import { resetLocalModelSettings } from '../../services/local/store.js'
import { disposeEngine } from '../../services/local/engine.js'
import paramStyles from './ParamControls.module.css'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import {
  closeSettings,
  setSettingsSection,
  useSettingsDialog,
  type SettingsSection,
} from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'model', label: 'settingDialogAsideModelOptionLabel', icon: <IconThinkOutline16 /> },
  { value: 'roles', label: 'settingDialogAsideRolesOptionLabel', icon: <IconRobotOutline16 /> },
  {
    value: 'local',
    label: 'settingDialogAsideLocalOptionLabel',
    icon: <IconChipOutline16 />,
  },
  { value: 'prompt', label: 'settingDialogAsidePromptOptionLabel', icon: <IconEditOutline16 /> },
  { value: 'cot', label: 'settingDialogAsideCotOptionLabel', icon: <IconCustomCotOutline16 /> },
  {
    value: 'poison',
    label: 'settingDialogAsidePoisonOptionLabel',
    icon: <IconSearchWarningOutline16 />,
  },
  {
    value: 'memory',
    label: 'settingDialogAsideMemoryOptionLabel',
    icon: <IconBranchOutline16 />,
  },
  {
    value: 'attachments',
    label: 'settingDialogAsideAttachmentsOptionLabel',
    icon: <IconPaperclipOutline16 />,
  },
  {
    value: 'agentTools',
    label: 'settingDialogAsideAgentToolsOptionLabel',
    icon: <IconRobotOutline16 />,
  },
  {
    value: 'workspace',
    label: 'settingDialogAsideWorkspaceOptionLabel',
    icon: <IconBrowseOutline16 />,
  },
  {
    value: 'nanovm',
    label: 'settingDialogAsideNanoVMOptionLabel',
    icon: <IconTerminalOutline16 />,
  },
  {
    value: 'unkernel',
    label: 'settingDialogAsideUnkernelOptionLabel',
    icon: <IconChipOutline16 />,
  },
  { value: 'stats', label: 'settingDialogAsideStatsOptionLabel', icon: <IconChartOutline16 /> },
  {
    value: 'account',
    label: 'settingDialogAsideAccountOptionLabel',
    icon: <IconWalletOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'about', label: 'settingDialogAsideAboutOptionLabel', icon: <IconLinkOutline16 /> },
  {
    value: 'changelog',
    label: 'settingDialogAsideChangelogOptionLabel',
    icon: <IconRefreshOutline16 />,
  },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const section = useSettingsDialog((state) => state.section)
  // 旧的自定义提示词 / 思维链各收进一个预设，之后可以克隆多套
  useEffect(() => {
    ensurePromptPresetsMigrated()
  }, [])
  const navigationRef = useRef<HTMLDivElement>(null)
  // 手机端导航横向滚动：打开较后的分组时把选中项滚到可视区域
  useEffect(() => {
    navigationRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [section])
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const [resetOpen, setResetOpen] = useState(false)
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div ref={navigationRef} role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSettingsSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ProfileCard />
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
              <DailyUsageSetting />
            </>
          ) : section === 'model' ? (
            <ModelSettings />
          ) : section === 'roles' ? (
            <RolesSettings />
          ) : section === 'local' ? (
            <LocalModelSettings />
          ) : section === 'prompt' ? (
            <UnrestrictedSetting />
          ) : section === 'cot' ? (
            <CustomCotSetting />
          ) : section === 'poison' ? (
            <SearchPoisonSettings />
          ) : section === 'memory' ? (
            <MemorySettings />
          ) : section === 'attachments' ? (
            <AttachmentsSetting />
          ) : section === 'agentTools' ? (
            <AgentToolsSetting />
          ) : section === 'workspace' ? (
            <WorkspaceSetting />
          ) : section === 'nanovm' ? (
            <>
              <NanoVMConsole />
              <WebVMConsole />
            </>
          ) : section === 'unkernel' ? (
            <UnkernelConsole />
          ) : section === 'stats' ? (
            <StatsSettings />
          ) : section === 'account' ? (
            <AccountSettings />
          ) : section === 'about' ? (
            <AboutSetting />
          ) : section === 'changelog' ? (
            <ChangelogSetting />
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('settingsResetAll')}
                description={t('settingsResetAllDescription')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={() => setResetOpen(true)}
                  >
                    {t('resetSettings')}
                  </Button>
                }
              />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      {resetOpen ? (
        <ResetSettingsConfirm
          onCancel={() => setResetOpen(false)}
          onConfirm={() => {
            resetSettings()
            resetPromptPresets()
            // 本地模型偏好与当前显存里的模型一并回到默认状态
            resetLocalModelSettings()
            void disposeEngine()
            setResetOpen(false)
            showToast({ key: 'resetSettingsDone' })
          }}
        />
      ) : null}
    </>
  )
}

/** 恢复默认设置确认：只重置设置，API Key 与对话数据保留。 */
const ResetSettingsConfirm = ({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('resetSettingsModalTitle')}
      className={styles.deleteConfirm}
      onClose={onCancel}
      footer={
        <div className={styles.deleteActions}>
          <Button variant="outlined" autoFocus onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t('resetSettings')}
          </Button>
        </div>
      }
    >
      {t('resetSettingsModalDescription')}
    </Modal>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const DailyUsageSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.dailyLimitEnabled)
  const tokenLimit = useSettings((state) => state.dailyTokenLimit)
  const costLimit = useSettings((state) => state.dailyCostLimit)
  const usage = useDailyUsage()
  useEffect(() => {
    syncDailyUsageDate()
  }, [])
  return (
    <>
      <div className={styles.groupTitle}>{t('dailyUsageSection')}</div>
      <SettingCell
        label={t('dailyLimitEnabledLabel')}
        description={t('dailyLimitEnabledDesc')}
        status={null}
        action={
          <Switch
            checked={enabled}
            onChange={setDailyLimitEnabled}
            label={t('dailyLimitEnabledLabel')}
          />
        }
      />
      <SettingCell
        label={t('dailyUsageTitle')}
        description={
          usage.totalTokens > usage.billedTokens
            ? `${t('dailyUsageText', {
                tokens: formatTokens(usage.totalTokens),
                cost: formatMoney(usage.cost),
              })}\n${t('dailyUsageLocalNote')}`
            : t('dailyUsageText', {
                tokens: formatTokens(usage.totalTokens),
                cost: formatMoney(usage.cost),
              })
        }
        status={null}
        action={
          <Button
            variant="outlined"
            size="m"
            disabled={usage.totalTokens === 0 && usage.cost === 0}
            onClick={() => {
              resetDailyUsage()
              showToast({ key: 'dailyResetToast' })
            }}
          >
            {t('dailyResetButton')}
          </Button>
        }
      />
      {enabled ? (
        <>
          <SettingCell
            label={t('dailyTokenLimitLabel')}
            status={null}
            action={
              <ParamControl
                label={t('dailyTokenLimitLabel')}
                value={tokenLimit}
                min={1000}
                max={100_000_000}
                step={1000}
                onChange={(value) => setDailyTokenLimit(value ?? 1_000_000)}
              />
            }
          />
          <SettingCell
            label={t('dailyCostLimitLabel')}
            status={null}
            action={
              <ParamControl
                label={t('dailyCostLimitLabel')}
                value={costLimit}
                min={0.01}
                max={1000}
                step={0.1}
                onChange={(value) => setDailyCostLimit(value ?? 10)}
              />
            }
          />
        </>
      ) : null}
    </>
  )
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined
  const [customDraft, setCustomDraft] = useState(location?.custom ?? '')
  // Esc 取消时不要触发失焦保存
  const skipCustomCommit = useRef(false)

  // 选择行政区、特殊位置或清除后，自定义输入框跟随设置值同步
  useEffect(() => {
    setCustomDraft(location?.custom ?? '')
  }, [location?.custom])

  const commitCustom = (value: string) => {
    const next = value.trim()
    if (next !== '') {
      if (next !== location?.custom) {
        setLocation({ region: 'CN', custom: next })
      }
      return
    }
    if (location?.custom) {
      setLocation(null)
    }
  }

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.place ? '' : (location?.region ?? '')}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
          <Select<string>
            ariaLabel={t('settingsLocationSpecial')}
            className={styles.specialSelect}
            value={location?.place ?? ''}
            placeholder={t('settingsLocationSpecial')}
            options={[
              { value: '', label: t('settingsLocationNone') },
              ...specialPlaces.map((item) => ({
                value: item.id,
                label: locale === 'zh-CN' ? item.zh : item.en,
              })),
            ]}
            onChange={(value) => {
              setLocation(value === '' ? null : { region: 'CN', place: value as SpecialPlace })
            }}
          />
          <input
            className={styles.locationCustomInput}
            aria-label={t('settingsLocationCustom')}
            placeholder={t('settingsLocationCustomPlaceholder')}
            maxLength={120}
            value={customDraft}
            onChange={(event) => setCustomDraft(event.target.value)}
            onBlur={(event) => {
              if (skipCustomCommit.current) {
                skipCustomCommit.current = false
                return
              }
              commitCustom(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                skipCustomCommit.current = true
                setCustomDraft(location?.custom ?? '')
                event.currentTarget.blur()
              }
            }}
          />
          {location ? (
            <Button variant="outlined" size="s" onClick={() => setLocation(null)}>
              {t('settingsLocationClear')}
            </Button>
          ) : null}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 关于：项目简介、仓库与演示地址、上游项目。 */
const AboutSetting = () => {
  const t = useTranslate()
  const version =
    document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? ''
  const links: { label: TranslationKey; href: string }[] = [
    {
      label: 'aboutRepositoryLabel',
      href: 'https://github.com/xiaohuangbo/chat-demo-unrestricted',
    },
    { label: 'aboutDemoLabel', href: 'https://chat-unrestricted.fur0.com/' },
    { label: 'aboutUpstreamLabel', href: 'https://github.com/deepseek-ai/chat-demo' },
  ]
  return (
    <div className={styles.about}>
      <div className={styles.aboutTitle}>
        {t('aboutProjectName')}
        {version ? <span className={styles.aboutVersion}>v{version}</span> : null}
      </div>
      <div className={styles.aboutDescription}>{t('aboutDescription')}</div>
      {links.map((link) => (
        <a
          key={link.href}
          className={styles.aboutLink}
          href={link.href}
          target="_blank"
          rel="noreferrer"
        >
          <span className={styles.aboutLinkLabel}>{t(link.label)}</span>
          {link.href}
        </a>
      ))}
      <UpdateCard />
    </div>
  )
}

/** 更新日志与上游鸣谢。 */
const ChangelogSetting = () => {
  const t = useTranslate()
  const groups: { title: TranslationKey; items: TranslationKey[] }[] = [
    {
      title: 'changelogV2716Title',
      items: [
        'changelogV2716CustomTool',
        'changelogV2716History',
        'changelogV2716Limits',
        'changelogV2716Apk',
      ],
    },
    {
      title: 'changelogV2715Title',
      items: [
        'changelogV2715Genui',
        'changelogV2715Attachments',
        'changelogV2715Progress',
        'changelogV2715Compat',
        'changelogV2715Apk',
      ],
    },
    {
      title: 'changelogV2714Title',
      items: [
        'changelogV2714Docs',
        'changelogV2714FirstTurnMemory',
        'changelogV2714MemoryHeader',
        'changelogV2714Apk',
      ],
    },
    {
      title: 'changelogV2713Title',
      items: ['changelogV2713ImportPerf', 'changelogV2713Docs', 'changelogV2713Apk'],
    },
    {
      title: 'changelogV2712Title',
      items: [
        'changelogV2712Tokenizer',
        'changelogV2712TagExpansion',
        'changelogV2712Debug',
        'changelogV2712Apk',
      ],
    },
    {
      title: 'changelogV2711Title',
      items: ['changelogV2711RootCause', 'changelogV2711Notice', 'changelogV2711Apk'],
    },
    {
      title: 'changelogV2710Title',
      items: [
        'changelogV2710LargeText',
        'changelogV2710Inline',
        'changelogV2710ImportProgress',
        'changelogV2710Apk',
      ],
    },
    {
      title: 'changelogV279Title',
      items: [
        'changelogV279Webvm',
        'changelogV279Unkernel',
        'changelogV279Settings',
        'changelogV279Apk',
      ],
    },
    {
      title: 'changelogV278Title',
      items: ['changelogV278V4Pro', 'changelogV278Credit', 'changelogV278Apk'],
    },
    {
      title: 'changelogV277Title',
      items: [
        'changelogV277Settings',
        'changelogV277Memory',
        'changelogV277Avatar',
        'changelogV277Android',
        'changelogV277Motion',
        'changelogV277Apk',
      ],
    },
    {
      title: 'changelogV276Title',
      items: [
        'changelogV276Import',
        'changelogV276Agent',
        'changelogV276Ui',
        'changelogV276Pybot',
        'changelogV276Docs',
        'changelogV276Apk',
      ],
    },
    {
      title: 'changelogV275Title',
      items: [
        'changelogV275Upstream',
        'changelogV275LocalMemory',
        'changelogV275Thinking',
        'changelogV275LocalTools',
        'changelogV275Remember',
        'changelogV275Presets',
        'changelogV275Icon',
        'changelogV275Docs',
        'changelogV275Apk',
      ],
    },
    {
      title: 'changelogV274Title',
      items: [
        'changelogV274Webllm',
        'changelogV274Switch',
        'changelogV274Mlc',
        'changelogV274Transfer',
        'changelogV274NoKey',
        'changelogV274Reset',
        'changelogV274Docs',
        'changelogV274Apk',
      ],
    },
    {
      title: 'changelogV273Title',
      items: [
        'changelogV273Mobile',
        'changelogV273Root',
        'changelogV273WebVmScroll',
        'changelogV273Refusal',
        'changelogV273Docs',
        'changelogV273Apk',
      ],
    },
    {
      title: 'changelogV272Title',
      items: [
        'changelogV272WebVM',
        'changelogV272Switch',
        'changelogV272Coi',
        'changelogV272Agent',
        'changelogV272Import',
        'changelogV272Docs',
        'changelogV272Apk',
      ],
    },
    {
      title: 'changelogV271Title',
      items: [
        'changelogV271Vnet',
        'changelogV271NodeWeb',
        'changelogV271PythonWeb',
        'changelogV271BuildTools',
        'changelogV271Commands',
        'changelogV271Apk',
      ],
    },
    {
      title: 'changelogV270Title',
      items: [
        'changelogV270Mobile',
        'changelogV270Commands',
        'changelogV270Jq',
        'changelogV270Toolchains',
        'changelogV270Make',
        'changelogV270Apk',
      ],
    },
    {
      title: 'changelogV269Title',
      items: [
        'changelogV269Update',
        'changelogV269Storage',
        'changelogV269Caret',
        'changelogV269Security',
        'changelogV269Docs',
        'changelogV269Apk',
      ],
    },
    {
      title: 'changelogV268Title',
      items: [
        'changelogV268Shell',
        'changelogV268Tools',
        'changelogV268Console',
        'changelogV268Agent',
        'changelogV268Memory',
        'changelogV268Keyboard',
        'changelogV268Reset',
        'changelogV268Modes',
        'changelogV268Net',
        'changelogV268Apk',
      ],
    },
    {
      title: 'changelogV267Title',
      items: [
        'changelogV267Cot',
        'changelogV267AnyFiles',
        'changelogV267UsageFix',
        'changelogV267Capacity',
        'changelogV267Billing',
        'changelogV267WorkspaceOpfs',
        'changelogV267Persist',
        'changelogV267Apk',
      ],
    },
    {
      title: 'changelogV265Title',
      items: [
        'changelogV265Workspace',
        'changelogV265WorkspaceTools',
        'changelogV265Defaults',
        'changelogV265Breakdown',
        'changelogV265Billing',
        'changelogV265Apk',
      ],
    },
    {
      title: 'changelogV264Title',
      items: [
        'changelogV264Tools',
        'changelogV264ToolLoop',
        'changelogV264ToolApproval',
        'changelogV264ToolCompat',
        'changelogV264Ledger',
        'changelogV264Charts',
        'changelogV264Export',
        'changelogV264Dialog',
        'changelogV264Compat',
        'changelogV264Apk',
      ],
    },
    {
      title: 'changelogV263Title',
      items: [
        'changelogV263LabKey',
        'changelogV263Stats',
        'changelogV263Context',
        'changelogV263Dialog',
        'changelogV263Apk',
      ],
    },
    {
      title: 'changelogV262Title',
      items: [
        'changelogV262Custom',
        'changelogV262Modes',
        'changelogV262Layout',
        'changelogV262Injected',
        'changelogV262Compatibility',
        'changelogV262Apk',
      ],
    },
    {
      title: 'changelogV261Title',
      items: ['changelogV261Android', 'changelogV261Backend', 'changelogV261Sign'],
    },
    {
      title: 'changelogV260Title',
      items: ['changelogV260Attachment', 'changelogV260Compatibility'],
    },
    {
      title: 'changelogV258Title',
      items: ['changelogV258Poison', 'changelogV258Location', 'changelogV258Consistency'],
    },
    {
      title: 'changelogV257Title',
      items: ['changelogV257Stream'],
    },
    {
      title: 'changelogV256Title',
      items: [
        'changelogV256Archive',
        'changelogV256ModelMobile',
        'changelogV256Graph',
        'changelogV256Dimension',
        'changelogV256Stats',
        'changelogV256Reset',
        'changelogV256Credits',
      ],
    },
    {
      title: 'changelogV255Title',
      items: [
        'changelogV255Preview',
        'changelogV255Location',
        'changelogV255Memory',
        'changelogV255Daily',
        'changelogV255Bank',
        'changelogV255Lab',
        'changelogV255Thinking',
        'changelogV255Mobile',
      ],
    },
    {
      title: 'changelogV252Title',
      items: ['changelogV252Toolbar'],
    },
    {
      title: 'changelogV251Title',
      items: [
        'changelogV251Mobile',
        'changelogV251Model',
        'changelogV251Billing',
        'changelogV251Lab',
      ],
    },
    {
      title: 'changelogV25Title',
      items: [
        'changelogV25Official',
        'changelogV25Reset',
        'changelogV25Fork',
        'changelogV25VariantIO',
        'changelogV25Mobile',
        'changelogV25Popover',
        'changelogV25IO',
      ],
    },
    {
      title: 'changelogV246Title',
      items: ['changelogV246Pressure', 'changelogV246Ring', 'changelogV246Summary'],
    },
    {
      title: 'changelogV245Title',
      items: [
        'changelogV245Inject',
        'changelogV245Zh',
        'changelogV245Compress',
        'changelogV245Credits',
      ],
    },
    {
      title: 'changelogV24Title',
      items: [
        'changelogV24Techniques',
        'changelogV24Variants',
        'changelogV24Budget',
        'changelogV24Refusal',
        'changelogV24Mobile',
      ],
    },
    {
      title: 'changelogV231Title',
      items: [
        'changelogV231Hover',
        'changelogV231Combo',
        'changelogV231Auto',
        'changelogV231Feedback',
      ],
    },
    {
      title: 'changelogV23Title',
      items: [
        'changelogV23Thinking',
        'changelogV23Context',
        'changelogV23Stats',
        'changelogV23Billing',
        'changelogV23Attachments',
        'changelogV23RaceIO',
      ],
    },
    {
      title: 'changelogV22Title',
      items: [
        'changelogV22Preset',
        'changelogV22Perturb',
        'changelogV22AutoTune',
        'changelogV22Stm',
        'changelogV22Race',
      ],
    },
    {
      title: 'changelogRecentTitle',
      items: [
        'changelogRecentLab',
        'changelogRecentImport',
        'changelogRecentMcp',
        'changelogRecentDocs',
      ],
    },
    {
      title: 'changelogEarlierTitle',
      items: [
        'changelogEarlierUnrestricted',
        'changelogEarlierParams',
        'changelogEarlierRetract',
        'changelogEarlierEdit',
        'changelogEarlierPrompt',
      ],
    },
  ]
  const credits: { label: TranslationKey; note: TranslationKey; href: string }[] = [
    {
      label: 'creditEasyJailbreakLabel',
      note: 'creditEasyJailbreakNote',
      href: 'https://github.com/EasyJailbreak/EasyJailbreak',
    },
    {
      label: 'creditDeepseekChatLabel',
      note: 'creditDeepseekChatNote',
      href: 'https://github.com/deepseek-ai/chat-demo',
    },
    {
      label: 'creditG0dm0d3Label',
      note: 'creditG0dm0d3Note',
      href: 'https://github.com/elder-plinius/G0DM0D3',
    },
    {
      label: 'creditDeepseekAgentLabel',
      note: 'creditDeepseekAgentNote',
      href: 'https://github.com/Aoan2011/DeepSeek-Agent',
    },
    {
      label: 'creditDshUnrestrictedLabel',
      note: 'creditDshUnrestrictedNote',
      href: 'https://github.com/yexi-by/dsh-unrestricted',
    },
    {
      label: 'creditLibertasLabel',
      note: 'creditLibertasNote',
      href: 'https://github.com/elder-plinius/L1B3RT4S',
    },
    {
      label: 'creditOperitLabel',
      note: 'creditOperitNote',
      href: 'https://github.com/AAswordman/Operit',
    },
    {
      label: 'creditDeepChatLabel',
      note: 'creditDeepChatNote',
      href: 'https://github.com/YanJiuWeiYuanHui/DeepChat',
    },
    {
      label: 'creditUnkernelLabel',
      note: 'creditUnkernelNote',
      href: 'https://github.com/pithings/unkernel',
    },
    {
      label: 'creditGoDeepseekLabel',
      note: 'creditGoDeepseekNote',
      href: 'https://github.com/robomotionio/go-deepseek',
    },
    {
      label: 'creditDshGenuiLabel',
      note: 'creditDshGenuiNote',
      href: 'https://github.com/omdsh-dev/dsh-genui',
    },
  ]
  return (
    <div className={styles.about}>
      <div className={styles.aboutTitle}>{t('changelogTitle')}</div>
      {groups.map((group) => (
        <div key={group.title} className={styles.changelogGroup}>
          <div className={styles.changelogGroupTitle}>{t(group.title)}</div>
          <ul className={styles.changelogList}>
            {group.items.map((item) => (
              <li key={item}>{t(item)}</li>
            ))}
          </ul>
        </div>
      ))}
      <div className={styles.aboutTitle}>{t('creditsTitle')}</div>
      {credits.map((credit) => (
        <div key={credit.href} className={styles.credit}>
          <a className={styles.aboutLink} href={credit.href} target="_blank" rel="noreferrer">
            <span className={styles.aboutLinkLabel}>{t(credit.label)}</span>
            {credit.href}
          </a>
          <div className={styles.creditNote}>{t(credit.note)}</div>
        </div>
      ))}
    </div>
  )
}

/**
 * 模型参数与回复开关：采样温度、Top P、每次回复的输出上限、流式输出与自动压缩。
 * 防撤回、跳过安全审核、拒绝后继续生成等绕过项集中在「破甲」页。
 */
const ModelSettings = () => {
  const t = useTranslate()
  const temperature = useSettings((state) => state.temperature)
  const topP = useSettings((state) => state.topP)
  const maxTokens = useSettings((state) => state.maxTokens)
  const model = useSettings((state) => state.model)
  const streamOutput = useSettings((state) => state.streamOutput)
  const refusalEnabled = useSettings((state) => state.refusalEnabled)
  const refusalKeywords = useSettings((state) => state.refusalKeywords)
  const refusalCaseSensitive = useSettings((state) => state.refusalCaseSensitive)
  const refusalMessage = useSettings((state) => state.refusalMessage)
  const autoCompress = useSettings((state) => state.autoCompress)
  const compressThreshold = useSettings((state) => state.compressThreshold)
  return (
    <>
      <SettingCell
        label={t('settingsModel')}
        description={t('settingsModelDescription')}
        status={null}
        action={<span className={styles.modelBadge}>{modelLabel(model)}</span>}
      />
      <SettingCell
        label={t('settingsStreamOutput')}
        description={t('settingsStreamOutputDescription')}
        status={null}
        action={
          <Switch
            checked={streamOutput}
            onChange={setStreamOutput}
            label={t('settingsStreamOutput')}
          />
        }
      />
      <SettingCell
        label={t('settingsTemperature')}
        description={t('settingsTemperatureDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsTemperature')}
            value={temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(value) => setTemperature(value ?? 1)}
          />
        }
      />
      <SettingCell
        label={t('settingsTopP')}
        description={t('settingsTopPDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsTopP')}
            value={topP}
            min={0.01}
            max={1}
            step={0.01}
            onChange={(value) => setTopP(value ?? 1)}
          />
        }
      />
      <SettingCell
        label={t('settingsMaxTokens')}
        description={t('settingsMaxTokensDescription')}
        status={null}
        className={paramStyles.cell}
        action={
          <ParamControl
            label={t('settingsMaxTokens')}
            value={maxTokens}
            min={1}
            max={65536}
            step={1}
            optional
            onChange={setMaxTokens}
          />
        }
      />
      <SettingCell
        label={t('settingsAutoCompress')}
        description={t('settingsAutoCompressDescription')}
        status={null}
        action={
          <Switch
            checked={autoCompress}
            onChange={setAutoCompress}
            label={t('settingsAutoCompress')}
          />
        }
      />
      <SettingCell
        label={t('settingsCompressThreshold')}
        description={t('settingsCompressThresholdDescription')}
        status={null}
        action={
          <Select
            value={String(compressThreshold)}
            ariaLabel={t('settingsCompressThreshold')}
            options={[
              { value: '0', label: t('settingsCompressThresholdAuto') },
              { value: '32000', label: '32K' },
              { value: '64000', label: '64K' },
              { value: '128000', label: '128K' },
              { value: '256000', label: '256K' },
              { value: '512000', label: '512K' },
              { value: '800000', label: '800K' },
            ]}
            onChange={(value) => setCompressThreshold(Number(value))}
          />
        }
      />

      <div className={styles.groupTitle}>{t('settingsRefusalSection')}</div>
      <SettingCell
        label={t('settingsRefusalEnabled')}
        description={t('settingsRefusalEnabledDescription')}
        status={null}
        action={
          <Switch
            checked={refusalEnabled}
            onChange={setRefusalEnabled}
            label={t('settingsRefusalEnabled')}
          />
        }
      />
      <SettingCell
        label={t('settingsRefusalCaseSensitive')}
        description={t('settingsRefusalCaseSensitiveDescription')}
        status={null}
        action={
          <Switch
            checked={refusalCaseSensitive}
            disabled={!refusalEnabled}
            onChange={setRefusalCaseSensitive}
            label={t('settingsRefusalCaseSensitive')}
          />
        }
      />
      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsRefusalKeywords')}</div>
          <div className={styles.description}>{t('settingsRefusalKeywordsDescription')}</div>
          <textarea
            className={styles.poisonTextarea}
            rows={4}
            value={refusalKeywords}
            placeholder={t('settingsRefusalKeywordsPlaceholder')}
            aria-label={t('settingsRefusalKeywords')}
            maxLength={4000}
            spellCheck={false}
            disabled={!refusalEnabled}
            onChange={(event) => setRefusalKeywords(event.target.value)}
          />
        </div>
      </div>
      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsRefusalMessage')}</div>
          <div className={styles.description}>{t('settingsRefusalMessageDescription')}</div>
          <textarea
            className={styles.poisonTextarea}
            rows={3}
            value={refusalMessage}
            placeholder={t('replyRefused')}
            aria-label={t('settingsRefusalMessage')}
            maxLength={2000}
            spellCheck={false}
            onChange={(event) => setRefusalMessage(event.target.value)}
          />
        </div>
      </div>
    </>
  )
}

/**
 * 破甲：解除限制模式、提示词预设、绕过与保留、输入扰动、自动调参与输出整形。
 *
 * 从「提示词」「模型」「高级」三页收拢到这里：越狱相关的开关不再分散，
 * 关闭时保持官方默认行为，所有改动只写入本机 localStorage。
 */
const UnrestrictedSetting = () => {
  const t = useTranslate()
  const unrestricted = useSettings((state) => state.unrestricted)
  const systemPrompt = useSettings((state) => state.systemPrompt)
  const promptPreset = useSettings((state) => state.promptPreset)
  const injectPrompt = useSettings((state) => state.injectPromptEveryTurn)
  const translateJailbreak = useSettings((state) => state.translateJailbreakZh)
  const thinkingAsBody = useSettings((state) => state.thinkingAsBody)
  const keepReplyContent = useSettings((state) => state.keepReplyContent)
  const skipSafetyCheck = useSettings((state) => state.skipSafetyCheck)
  const continueRefused = useSettings((state) => state.continueRefused)
  const autoJailbreak = useSettings((state) => state.autoJailbreak)
  const parseltongue = useSettings((state) => state.parseltongue)
  const technique = useSettings((state) => state.parseltongueTechnique)
  const intensity = useSettings((state) => state.parseltongueIntensity)
  const autoTune = useSettings((state) => state.autoTune)
  const strategy = useSettings((state) => state.autoTuneStrategy)
  const stmModules = useSettings((state) => state.stmModules)
  const feedbackSamples = useFeedback((state) => state.state.history.length)

  const presets: { value: PromptPreset; label: string }[] = [
    { value: 'deepseek', label: t('settingsPromptPresetDeepseek') },
    { value: 'godmode', label: t('settingsPromptPresetGodmode') },
  ]
  const techniques: { value: ObfuscationTechnique; label: string }[] = [
    { value: 'leetspeak', label: t('settingsTechniqueLeetspeak') },
    { value: 'unicode', label: t('settingsTechniqueUnicode') },
    { value: 'zwj', label: t('settingsTechniqueZwj') },
    { value: 'mixedcase', label: t('settingsTechniqueMixedcase') },
    { value: 'phonetic', label: t('settingsTechniquePhonetic') },
    { value: 'fullwidth', label: t('settingsTechniqueFullwidth') },
    { value: 'spacing', label: t('settingsTechniqueSpacing') },
    { value: 'random', label: t('settingsTechniqueRandom') },
  ]
  const intensities: { value: 'light' | 'medium' | 'heavy'; label: string }[] = [
    { value: 'light', label: t('settingsIntensityLight') },
    { value: 'medium', label: t('settingsIntensityMedium') },
    { value: 'heavy', label: t('settingsIntensityHeavy') },
  ]
  const strategies: { value: AutoTuneStrategy; label: string }[] = [
    { value: 'adaptive', label: t('settingsAutoTuneAdaptive') },
    { value: 'precise', label: t('settingsAutoTunePrecise') },
    { value: 'balanced', label: t('settingsAutoTuneBalanced') },
    { value: 'creative', label: t('settingsAutoTuneCreative') },
    { value: 'chaotic', label: t('settingsAutoTuneChaotic') },
  ]
  const stmRows: { id: string; label: string }[] = [
    { id: 'hedge_reducer', label: t('settingsStmHedge') },
    { id: 'direct_mode', label: t('settingsStmDirect') },
    { id: 'casual_mode', label: t('settingsStmCasual') },
  ]

  return (
    <>
      <div className={styles.groupTitle}>{t('settingsJailbreakCore')}</div>
      <SettingCell
        label={t('settingsUnrestricted')}
        description={t('settingsUnrestrictedDescription')}
        status={null}
        action={
          <Switch
            checked={unrestricted}
            onChange={setUnrestricted}
            label={t('settingsUnrestricted')}
          />
        }
      />
      <SettingCell
        label={t('settingsPromptPreset')}
        description={t('settingsPromptPresetDescription')}
        status={null}
        action={
          <Select
            value={promptPreset}
            options={presets}
            onChange={setPromptPreset}
            ariaLabel={t('settingsPromptPreset')}
          />
        }
      />
      <SettingCell
        label={t('autoJailbreak')}
        description={t('autoJailbreakDescription')}
        status={null}
        action={
          <Switch checked={autoJailbreak} onChange={setAutoJailbreak} label={t('autoJailbreak')} />
        }
      />
      <SettingCell
        label={t('settingsTranslateJailbreak')}
        description={t('settingsTranslateJailbreakDescription')}
        status={null}
        action={
          <Switch
            checked={translateJailbreak}
            onChange={setTranslateJailbreakZh}
            label={t('settingsTranslateJailbreak')}
          />
        }
      />
      <SettingCell
        label={t('settingsInjectPrompt')}
        description={t('settingsInjectPromptDescription')}
        status={null}
        action={
          <Switch
            checked={injectPrompt}
            onChange={setInjectPromptEveryTurn}
            label={t('settingsInjectPrompt')}
          />
        }
      />
      <SettingCell
        label={t('settingsThinkingAsBody')}
        description={t('settingsThinkingAsBodyDescription')}
        status={null}
        action={
          <Switch
            checked={thinkingAsBody}
            onChange={setThinkingAsBody}
            label={t('settingsThinkingAsBody')}
          />
        }
      />

      <div className={styles.groupTitle}>{t('settingsJailbreakBypass')}</div>
      <SettingCell
        label={t('settingsKeepReply')}
        description={t('settingsKeepReplyDescription')}
        status={null}
        action={
          <Switch
            checked={keepReplyContent}
            onChange={setKeepReplyContent}
            label={t('settingsKeepReply')}
          />
        }
      />
      <SettingCell
        label={t('settingsSkipSafetyCheck')}
        description={t('settingsSkipSafetyCheckDescription')}
        status={null}
        action={
          <Switch
            checked={skipSafetyCheck || unrestricted}
            disabled={unrestricted}
            onChange={setSkipSafetyCheck}
            label={t('settingsSkipSafetyCheck')}
          />
        }
      />
      <SettingCell
        label={t('settingsContinueRefused')}
        description={t('settingsContinueRefusedDescription')}
        status={null}
        action={
          <Switch
            checked={continueRefused || unrestricted}
            disabled={unrestricted}
            onChange={setContinueRefused}
            label={t('settingsContinueRefused')}
          />
        }
      />

      <div className={styles.groupTitle}>{t('settingsJailbreakObfuscation')}</div>
      <SettingCell
        label={t('settingsParseltongue')}
        description={t('settingsParseltongueDescription')}
        status={null}
        action={
          <Switch
            checked={parseltongue}
            onChange={setParseltongue}
            label={t('settingsParseltongue')}
          />
        }
      />
      <SettingCell
        label={t('settingsParseltongueTechnique')}
        description={t('settingsParseltongueTechniqueDescription')}
        status={null}
        action={
          <Select
            value={technique}
            options={techniques}
            onChange={setParseltongueTechnique}
            ariaLabel={t('settingsParseltongueTechnique')}
          />
        }
      />
      <SettingCell
        label={t('settingsParseltongueIntensity')}
        description={t('settingsParseltongueIntensityDescription')}
        status={null}
        action={
          <Select
            value={intensity}
            options={intensities}
            onChange={setParseltongueIntensity}
            ariaLabel={t('settingsParseltongueIntensity')}
          />
        }
      />
      <div className={styles.pipeline}>{t('settingsParseltongueHint')}</div>

      <div className={styles.groupTitle}>{t('settingsJailbreakAutoTune')}</div>
      <SettingCell
        label={t('settingsAutoTune')}
        description={t('settingsAutoTuneDescription')}
        status={null}
        action={<Switch checked={autoTune} onChange={setAutoTune} label={t('settingsAutoTune')} />}
      />
      <SettingCell
        label={t('settingsAutoTuneStrategy')}
        description={t('settingsAutoTuneStrategyDescription')}
        status={null}
        action={
          <Select
            value={strategy}
            options={strategies}
            onChange={setAutoTuneStrategy}
            ariaLabel={t('settingsAutoTuneStrategy')}
          />
        }
      />
      <div className={styles.pipeline}>{t('settingsAutoTuneHint')}</div>

      <div className={styles.groupTitle}>{t('settingsJailbreakStm')}</div>
      {stmRows.map((row, index) => (
        <SettingCell
          key={row.id}
          label={row.label}
          description={index === 0 ? t('settingsStmDescription') : undefined}
          status={null}
          action={
            <Switch
              checked={stmModules.includes(row.id)}
              onChange={(enabled) =>
                setStmModules(
                  enabled ? [...stmModules, row.id] : stmModules.filter((id) => id !== row.id)
                )
              }
              label={row.label}
            />
          }
        />
      ))}
      <div className={styles.pipeline}>{t('settingsStmHint')}</div>
      <div className={styles.pipeline}>
        {t('settingsFeedbackStats', { count: feedbackSamples })}
      </div>

      <div className={styles.groupTitle}>{t('settingsJailbreakPrompt')}</div>
      <SystemPromptSetting />
      <div className={styles.pipeline}>
        {t(
          systemPrompt !== null
            ? 'settingsPipelineCustom'
            : promptPreset === 'godmode'
              ? 'settingsPipelineGodmode'
              : unrestricted
                ? 'settingsPipelineUnrestricted'
                : 'settingsPipelineDefault'
        )}
      </div>
      <details className={styles.promptPreview}>
        <summary className={styles.promptPreviewSummary}>{t('settingsPromptPreview')}</summary>
        <pre className={styles.promptPreviewBody}>
          {composeSystemPrompt(unrestricted, systemPrompt, promptPreset, translateJailbreak)}
        </pre>
      </details>
    </>
  )
}

/**
 * 自定义系统提示词：留空沿用自动组装结果，填写后原样作为 system 下发。
 * 草稿独立于设置值，清空输入框不会立刻回填默认内容；「填入默认」把当前组装结果填进输入框。
 */
const SystemPromptSetting = () => {
  const t = useTranslate()
  const unrestricted = useSettings((state) => state.unrestricted)
  const systemPrompt = useSettings((state) => state.systemPrompt)
  const promptPreset = useSettings((state) => state.promptPreset)
  const translateJailbreak = useSettings((state) => state.translateJailbreakZh)
  const activePresetId = usePromptPresets((state) => state.systemActiveId)
  const [draft, setDraft] = useState(systemPrompt ?? '')

  // 外部重置（恢复默认）或切换分组后同步草稿
  useEffect(() => {
    setDraft(systemPrompt ?? '')
  }, [systemPrompt])

  const commit = (value: string) => {
    setDraft(value)
    setSystemPrompt(value)
    if (activePresetId) {
      updatePresetContent('system', activePresetId, value)
    }
  }

  const applyPreset = (value: string) => {
    setDraft(value)
    setSystemPrompt(value)
  }

  return (
    <div className={styles.systemPromptWrapper}>
      <PromptPresetBar kind="system" content={draft} onApply={applyPreset} />
      <div className={styles.systemPrompt}>
        <div className={styles.systemPromptHead}>
          <div className={styles.systemPromptLabel}>{t('settingsCustomPrompt')}</div>
          <div className={styles.systemPromptDescription}>
            {t('settingsCustomPromptDescription')}
          </div>
        </div>
        <textarea
          className={styles.systemPromptTextarea}
          aria-label={t('settingsCustomPrompt')}
          rows={6}
          placeholder={t('settingsCustomPromptPlaceholder')}
          value={draft}
          onChange={(event) => commit(event.target.value)}
        />
        <div className={styles.systemPromptActions}>
          <span className={styles.systemPromptHint}>
            {t(systemPrompt === null ? 'settingsCustomPromptAuto' : 'settingsCustomPromptCustom')}
          </span>
          <Button
            variant="outlined"
            size="s"
            onClick={() =>
              commit(composeSystemPrompt(unrestricted, null, promptPreset, translateJailbreak))
            }
          >
            {t('settingsCustomPromptFill')}
          </Button>
          <Button
            variant="outlined"
            size="s"
            disabled={systemPrompt === null}
            onClick={() => commit('')}
          >
            {t('settingsCustomPromptReset')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * 自定义思维链：预先写好推理步骤，请求前作为独立 system 分块注入。
 * 关闭深度思考时直接约束作答过程；开启时只是实验性引导，服务端可能重写。
 */
const CustomCotSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.customCotEnabled)
  const text = useSettings((state) => state.customCot)
  const thinking = useSettings((state) => state.thinking)
  const activePresetId = usePromptPresets((state) => state.cotActiveId)
  const [draft, setDraft] = useState(text)

  // 恢复默认或从其他入口修改时同步草稿
  useEffect(() => {
    setDraft(text)
  }, [text])

  const commit = (value: string) => {
    setDraft(value)
    setCustomCot(value)
    if (activePresetId) {
      updatePresetContent('cot', activePresetId, value)
    }
  }
  const applyPreset = (value: string) => {
    setDraft(value)
    setCustomCot(value)
  }
  const empty = draft.trim() === ''

  return (
    <>
      <SettingCell
        label={t('settingsCustomCot')}
        description={t('settingsCustomCotDescription')}
        status={null}
        action={
          <Switch checked={enabled} onChange={setCustomCotEnabled} label={t('settingsCustomCot')} />
        }
      />
      <div className={styles.systemPromptWrapper}>
        <PromptPresetBar kind="cot" content={draft} onApply={applyPreset} />
        <div className={styles.systemPrompt}>
          <div className={styles.systemPromptHead}>
            <div className={styles.systemPromptLabel}>{t('settingsCustomCotEditorLabel')}</div>
            <div className={styles.systemPromptDescription}>
              {t('settingsCustomCotEditorDescription')}
            </div>
          </div>
          <textarea
            className={styles.systemPromptTextarea}
            aria-label={t('settingsCustomCotEditorLabel')}
            rows={7}
            maxLength={CUSTOM_COT_MAX_CHARS}
            placeholder={t('settingsCustomCotPlaceholder')}
            value={draft}
            onChange={(event) => commit(event.target.value)}
          />
          <div className={styles.systemPromptActions}>
            <span className={styles.systemPromptHint}>
              {t('settingsCustomCotCount', { count: draft.length, max: CUSTOM_COT_MAX_CHARS })}
            </span>
            <Button variant="outlined" size="s" onClick={() => commit(DEFAULT_CUSTOM_COT)}>
              {t('settingsCustomCotInsertExample')}
            </Button>
            <Button variant="outlined" size="s" disabled={draft === ''} onClick={() => commit('')}>
              {t('settingsCustomCotClear')}
            </Button>
          </div>
        </div>
      </div>
      <div className={styles.cotStatus} data-experimental={thinking || undefined}>
        <div className={styles.cotStatusTitle}>
          {t(
            thinking ? 'settingsCustomCotStatusThinkingTitle' : 'settingsCustomCotStatusDirectTitle'
          )}
        </div>
        <div className={styles.cotStatusBody}>
          {t(
            thinking
              ? 'settingsCustomCotStatusThinkingDescription'
              : 'settingsCustomCotStatusDirectDescription'
          )}
        </div>
      </div>
      <div className={styles.pipeline}>
        {t(
          !enabled
            ? 'settingsCustomCotOffHint'
            : empty
              ? 'settingsCustomCotEmpty'
              : 'settingsCustomCotActiveHint'
        )}
      </div>
      {empty ? null : (
        <details className={styles.promptPreview}>
          <summary className={styles.promptPreviewSummary}>{t('settingsCustomCotPreview')}</summary>
          <pre className={styles.promptPreviewBody}>{formatCustomCotContext(draft, thinking)}</pre>
        </details>
      )}
    </>
  )
}

/**
 * 附件限制：默认按内置规则校验（单文件 64 MB、单会话 50 个、扩展名白名单），
 * 也可以关掉校验或改成自己的数值与白名单；改动立即对下一次选择和上传生效。
 */
const AttachmentsSetting = () => {
  const t = useTranslate()
  const limitEnabled = useSettings((state) => state.attachmentLimits)
  const maxMB = useSettings((state) => state.attachmentMaxMB)
  const maxCount = useSettings((state) => state.attachmentMaxCount)
  const exts = useSettings((state) => state.attachmentExts)
  const largeText = useSettings((state) => state.attachmentLargeText)
  const largeTextInline = useSettings((state) => state.attachmentLargeTextInline)
  const [draft, setDraft] = useState(exts ? exts.join(', ') : '')

  useEffect(() => {
    setDraft(exts ? exts.join(', ') : '')
  }, [exts])

  const commitExts = (value: string) => {
    setDraft(value)
    setAttachmentExts(
      value
        .split(/[,\n\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  }

  return (
    <>
      <SettingCell
        label={t('attachmentsLimit')}
        description={t('attachmentsLimitDescription')}
        status={null}
        action={
          <Switch
            checked={limitEnabled}
            onChange={setAttachmentLimits}
            label={t('attachmentsLimit')}
          />
        }
      />
      {limitEnabled ? null : <div className={styles.pipeline}>{t('attachmentsLimitsOff')}</div>}
      <SettingCell
        label={t('attachmentsMaxMB')}
        description={t('attachmentsMaxMBDescription')}
        status={null}
        action={
          <ParamControl
            label={t('attachmentsMaxMB')}
            value={maxMB}
            min={1}
            max={1024}
            step={1}
            optional
            onChange={setAttachmentMaxMB}
          />
        }
      />
      <SettingCell
        label={t('attachmentsMaxCount')}
        description={t('attachmentsMaxCountDescription')}
        status={null}
        action={
          <ParamControl
            label={t('attachmentsMaxCount')}
            value={maxCount}
            min={1}
            max={500}
            step={1}
            optional
            onChange={setAttachmentMaxCount}
          />
        }
      />
      <div className={styles.systemPrompt}>
        <div className={styles.systemPromptHead}>
          <div className={styles.systemPromptLabel}>{t('attachmentsExts')}</div>
          <div className={styles.systemPromptDescription}>{t('attachmentsExtsDescription')}</div>
        </div>
        <textarea
          className={styles.systemPromptTextarea}
          aria-label={t('attachmentsExts')}
          rows={4}
          spellCheck={false}
          placeholder={t('attachmentsExtsPlaceholder')}
          value={draft}
          onChange={(event) => commitExts(event.target.value)}
        />
        <div className={styles.systemPromptActions}>
          <span className={styles.systemPromptHint}>
            {exts === null
              ? t('attachmentsExtsPlaceholder')
              : t('attachmentsExtsCount', { count: exts.length })}
          </span>
          <Button
            variant="outlined"
            size="s"
            disabled={exts === null}
            onClick={() => setAttachmentExts(null)}
          >
            {t('attachmentsExtsReset')}
          </Button>
        </div>
      </div>

      <div className={styles.groupTitle}>
        {t('settingDialogAsideAttachmentLargeTextOptionLabel')}
      </div>
      <SettingCell
        label={t('attachmentsLargeText')}
        description={t('attachmentsLargeTextDescription')}
        status={null}
        action={
          <Switch
            checked={largeText}
            onChange={setAttachmentLargeText}
            label={t('attachmentsLargeText')}
          />
        }
      />
      {largeText ? (
        <>
          <SettingCell
            label={t('attachmentsLargeTextInline')}
            description={t('attachmentsLargeTextInlineDescription')}
            status={null}
            action={
              <Switch
                checked={largeTextInline}
                onChange={setAttachmentLargeTextInline}
                label={t('attachmentsLargeTextInline')}
              />
            }
          />
          <div className={styles.pipeline}>
            {t(
              largeTextInline ? 'attachmentsLargeTextInlineHint' : 'attachmentsLargeTextSplitHint',
              { limit: LARGE_TEXT_TOKEN_LIMIT }
            )}
          </div>
        </>
      ) : null}

      <div className={styles.groupTitle}>{t('settingDialogAsideAttachmentPoisonOptionLabel')}</div>
      <AttachmentPoisonSettings />
    </>
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  /** 导入进度：已处理条目 / 总条目与已写入暂存的会话数 */
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    setProgress({ done: 0, total: 0 })
    try {
      const count = await importHistory(file, setProgress)
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
      setProgress(null)
    }
  }

  return { file, busy, status, progress, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const { busy, progress } = historyImport
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0
  // 导入期间把状态换成百分比，并在下面单独画进度条
  const status = busy
    ? { key: 'historyImportInProgress' as const, params: { percent } }
    : historyImport.status

  return (
    <>
      <SettingCell
        label={t('historyImport')}
        description={t('historyImportDescription')}
        status={status}
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {t('upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  historyImport.select(file)
                }
              }}
            />
          </>
        }
      />
      {busy ? (
        <div className={styles.importProgress}>
          <div
            className={styles.importProgressBar}
            role="progressbar"
            aria-label={t('historyImportProgressLabel')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className={styles.importProgressFill} style={{ width: `${percent}%` }} />
          </div>
          <div className={styles.importProgressText}>
            {progress && progress.total > 0
              ? t('historyImportProgress', {
                  done: progress.done,
                  total: progress.total,
                  percent,
                })
              : t('historyImportProgressPending')}
          </div>
        </div>
      ) : null}
    </>
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
