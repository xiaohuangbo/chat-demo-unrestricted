import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { CUSTOM_INJECTION_TOOL_ID } from '../../services/agent/tools.js'
import {
  customHistoryEnabled,
  customInjectionDefinition,
  customInjectionReady,
  normalizeCustomInjection,
  type CustomAssistantRule,
  type CustomUserRule,
} from '../../services/agent/customInjection.js'
import { setAgentToolEnabled, useAgentTools } from '../../services/agent/agentToolSettings.js'
import { setCustomTool, useSettings } from '../../services/settings.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import styles from './CustomToolSetting.module.css'

/**
 * 设置 → 浏览器工具 → 提示词注入工具（自定义）。
 *
 * 用户自己定义工具名、描述与参数名；请求里把 tool_choice 指向它，
 * 模型只能把回答正文写进参数，收到回应后由 chat store 还原成普通正文。
 * 这里只负责编辑配置，请求组装与历史还原分别在 store.ts / customInjection.ts。
 */
export const CustomToolSetting = () => {
  const t = useTranslate()
  const config = useSettings((state) => state.customTool)
  const masterEnabled = useAgentTools((state) => state.enabled)
  const flags = useAgentTools((state) => state.flags)
  const enabled = masterEnabled && flags[CUSTOM_INJECTION_TOOL_ID] !== false
  const [open, setOpen] = useState(false)

  const ready = customInjectionReady(config)
  const historyOn = customHistoryEnabled(config)

  const assistantOptions: { value: CustomAssistantRule; label: string }[] = [
    { value: 'off', label: t('customToolAssistant_off') },
    { value: 'generated', label: t('customToolAssistant_generated') },
    { value: 'all', label: t('customToolAssistant_all') },
  ]
  const userOptions: { value: CustomUserRule; label: string }[] = [
    { value: 'off', label: t('customToolUser_off') },
    { value: 'paired', label: t('customToolUser_paired') },
    { value: 'marked', label: t('customToolUser_marked') },
  ]

  const preview = useMemo(
    () =>
      JSON.stringify(
        customInjectionDefinition(normalizeCustomInjection(config)),
        null,
        2
      ),
    [config]
  )

  return (
    <div className={styles.card} data-custom-tool="panel" data-on={enabled || undefined}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.headText}>
          <span className={styles.title}>{t('customToolSectionTitle')}</span>
          <span className={styles.desc}>{t('customToolSectionDesc')}</span>
          <span className={styles.meta}>
            <code className={styles.code}>{config.name || '—'}</code>
            <span className={styles.dot} aria-hidden>
              ·
            </span>
            <code className={styles.code}>{config.paramName || '—'}</code>
            {config.forceToolChoice ? (
              <span className={styles.chip}>{t('customToolForceLabel')}</span>
            ) : null}
            {historyOn ? <span className={styles.chip}>{t('customToolHistoryTitle')}</span> : null}
            {!ready ? <span className={styles.chipWarn}>{t('customToolChipIncomplete')}</span> : null}
          </span>
        </span>
        <span className={styles.headActions}>
          <Switch
            checked={enabled}
            disabled={!masterEnabled}
            onChange={(value) => setAgentToolEnabled(CUSTOM_INJECTION_TOOL_ID, value)}
            label={t('customToolSectionTitle')}
          />
          <span className={styles.chevron} data-open={open || undefined} aria-hidden>
            ▾
          </span>
        </span>
      </button>

      {open ? (
        <div className={styles.body}>
          {!ready ? (
            <div className={styles.error}>
              {config.name === '' || config.paramName === ''
                ? t('customToolNameInvalid')
                : t('customToolParamInvalid')}
            </div>
          ) : null}

          <div className={styles.groupTitle}>{t('customToolConfigTitle')}</div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="custom-tool-name">
              {t('customToolNameLabel')}
            </label>
            <div className={styles.hint}>{t('customToolNameDesc')}</div>
            <input
              id="custom-tool-name"
              className={styles.input}
              value={config.name}
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setCustomTool({ name: event.target.value })}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="custom-tool-desc">
              {t('customToolDescriptionLabel')}
            </label>
            <div className={styles.hint}>{t('customToolDescriptionDesc')}</div>
            <textarea
              id="custom-tool-desc"
              className={styles.textarea}
              rows={4}
              maxLength={4000}
              spellCheck={false}
              value={config.description}
              onChange={(event) => setCustomTool({ description: event.target.value })}
            />
          </div>

          <div className={styles.grid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="custom-tool-param">
                {t('customToolParamLabel')}
              </label>
              <div className={styles.hint}>{t('customToolParamDesc')}</div>
              <input
                id="custom-tool-param"
                className={styles.input}
                value={config.paramName}
                maxLength={64}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setCustomTool({ paramName: event.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="custom-tool-param-desc">
                {t('customToolParamDescLabel')}
              </label>
              <input
                id="custom-tool-param-desc"
                className={styles.input}
                value={config.paramDescription}
                maxLength={1000}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setCustomTool({ paramDescription: event.target.value })}
              />
            </div>
          </div>

          <div className={styles.switchRow}>
            <div className={styles.switchText}>
              <div className={styles.label}>{t('customToolForceLabel')}</div>
              <div className={styles.hint}>{t('customToolForceDesc')}</div>
            </div>
            <Switch
              checked={config.forceToolChoice}
              onChange={(value) => setCustomTool({ forceToolChoice: value })}
              label={t('customToolForceLabel')}
            />
          </div>
          <div className={styles.note}>{t('customToolRestoreNote')}</div>

          <div className={styles.groupTitle}>{t('customToolHistoryTitle')}</div>
          <div className={styles.note}>{t('customToolHistoryDesc')}</div>
          <div className={styles.grid}>
            <div className={styles.field}>
              <div className={styles.label}>{t('customToolAssistantRuleLabel')}</div>
              <Select
                ariaLabel={t('customToolAssistantRuleLabel')}
                value={config.assistantRule}
                options={assistantOptions}
                onChange={(assistantRule) => setCustomTool({ assistantRule })}
              />
            </div>
            <div className={styles.field}>
              <div className={styles.label}>{t('customToolUserRuleLabel')}</div>
              <Select
                ariaLabel={t('customToolUserRuleLabel')}
                value={config.userRule}
                options={userOptions}
                onChange={(userRule) => setCustomTool({ userRule })}
              />
            </div>
          </div>
          {config.userRule === 'marked' ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="custom-tool-marker">
                {t('customToolMarkerLabel')}
              </label>
              <div className={styles.hint}>{t('customToolMarkerDesc')}</div>
              <input
                id="custom-tool-marker"
                className={styles.input}
                value={config.marker}
                maxLength={40}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setCustomTool({ marker: event.target.value })}
              />
            </div>
          ) : null}

          <details className={styles.preview}>
            <summary className={styles.previewSummary}>{t('customToolPreviewTitle')}</summary>
            <div className={styles.previewBlock}>
              <div className={styles.previewLabel}>{t('customToolPreviewTool')}</div>
              <pre className={styles.pre}>{preview}</pre>
            </div>
            <div className={styles.previewBlock}>
              <div className={styles.previewLabel}>{t('customToolPreviewHistory')}</div>
              <pre className={styles.pre}>
                {historyOn
                  ? historyShape(normalizeCustomInjection(config))
                  : t('customToolPreviewOff')}
              </pre>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  )
}

/** 历史转换后的请求形状：按当前规则生成一段样例，方便对照 */
const historyShape = (
  config: ReturnType<typeof normalizeCustomInjection>
): string => {
  const name = config.name || 'emit_answer'
  const param = config.paramName || 'content'
  const lines = ['user        「第一问」']
  // 助手规则为 all 时普通回答也还原；marked 只还原带标记的提问
  const assistantOn = config.assistantRule !== 'off'
  const userOn = config.userRule !== 'off'
  if (assistantOn && userOn) {
    lines.push(`assistant   tool_use ${name} {${param}: "第一答"}`)
    lines.push(`user        tool_result(toolu_…)${config.userRule === 'marked' ? ' （仅带标记的提问）' : ''} 「第二问」`)
    lines.push(`assistant   tool_use ${name} {${param}: "第二答"}`)
    lines.push('user        「本轮提问」')
  } else {
    lines.push('assistant   「第一答」')
    lines.push('user        「第二问」')
    lines.push('assistant   「第二答」')
    lines.push('user        「本轮提问」')
  }
  return lines.join('\n')
}
