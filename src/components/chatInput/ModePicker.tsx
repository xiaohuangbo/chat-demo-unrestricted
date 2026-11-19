import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckedOutline14, IconChevronDownOutline14, IconModeLayers16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  CHAT_MODES,
  modePolicy,
  setChatMode,
  useChatMode,
  type ChatMode,
} from '../../services/chat/mode.js'
import { useAgentTools } from '../../services/agent/agentToolSettings.js'
import { useWorkspace } from '../../services/workspace/store.js'
import { useNanoVMConfig } from '../../services/nanovm/config.js'
import { useWebVMConfig } from '../../services/webvm/config.js'
import { useSettings } from '../../services/settings.js'
import styles from './ModePicker.module.css'

/** 模式名与说明的文案 key */
const MODE_LABEL: Record<ChatMode, TranslationKey> = {
  chat: 'chatModeChat',
  web: 'chatModeWeb',
  ptc: 'chatModePtc',
  creator: 'chatModeCreator',
}

const MODE_HINT: Record<ChatMode, TranslationKey> = {
  chat: 'chatModeChatHint',
  web: 'chatModeWebHint',
  ptc: 'chatModePtchHint',
  creator: 'chatModeCreatorHint',
}

/**
 * 输入栏的聊天模式切换：胶囊按钮 + 四项带说明的菜单。
 *
 * 模式只在设置之上「再加一道限制」：对应的工具主开关关着时，菜单项里补一行灰字
 * 说明这些工具不会下发（开关状态订阅 store，打开面板前改设置也会立刻反映）。
 */
export const ModePicker = ({
  triggerClassName,
  selectedClassName,
  labelClassName,
}: {
  triggerClassName: string
  selectedClassName: string
  labelClassName: string
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const mode = useChatMode((state) => state.mode)
  const browserOn = useAgentTools((state) => state.enabled)
  const workspaceOn = useWorkspace((state) => state.enabled)
  const nanoVMOn = useNanoVMConfig((state) => state.enabled && state.allowAgent)
  const webVMOn = useWebVMConfig((state) => state.enabled && state.allowAgent)
  const [open, setOpen] = useState(false)

  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'start',
    offset: 8,
    maxHeight: 520,
    minSpace: 240,
    measureKey: `${browserOn}-${workspaceOn}-${nanoVMOn}-${webVMOn}`,
  })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  /** 这个模式下哪些分组的开关没打开 */
  const offItems = (item: ChatMode): string[] => {
    const { groups } = modePolicy(item)
    const off: string[] = []
    if (groups.includes('browser') && !browserOn) {
      off.push(t('chatModeOffBrowser'))
    }
    if (groups.includes('workspace') && !workspaceOn) {
      off.push(t('chatModeOffWorkspace'))
    }
    if (groups.includes('nanovm') && !nanoVMOn && !webVMOn) {
      off.push(t('chatModeOffNanoVM'))
    }
    return off
  }

  const modeName = t(MODE_LABEL[mode])
  // 图标态（<400px）也要能看出当前模式，所以标签里带上模式名
  const triggerLabel = `${t('chatModeLabel')}${locale === 'en-US' ? ': ' : '：'}${modeName}`

  const choose = (item: ChatMode) => {
    setChatMode(item)
    setOpen(false)
    showToast({ key: 'chatModeChanged', params: { mode: t(MODE_LABEL[item]) } })
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(
          triggerClassName,
          styles.trigger,
          open && selectedClassName,
          open && styles.open
        )}
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-mode={mode}
        onClick={() => setOpen((value) => !value)}
      >
        <IconModeLayers16 />
        <span className={clsx(labelClassName, styles.label)}>{modeName}</span>
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
              role="menu"
              aria-label={t('chatModeLabel')}
            >
              <div className={styles.head}>
                <span className={styles.title}>{t('chatModeLabel')}</span>
                <span className={styles.current}>{t(MODE_LABEL[mode])}</span>
              </div>
              <div className={styles.list}>
                {CHAT_MODES.map((item) => {
                  const active = item === mode
                  const off = offItems(item)
                  return (
                    <button
                      key={item}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={clsx(styles.option, active && styles.active)}
                      onClick={() => choose(item)}
                    >
                      <span className={styles.optionMain}>
                        <span className={styles.optionName}>{t(MODE_LABEL[item])}</span>
                        <span className={styles.optionHint}>{t(MODE_HINT[item])}</span>
                        {off.length > 0 ? (
                          <span className={styles.optionOff}>
                            {t('chatModeOffHint', {
                              items: off.join(locale === 'en-US' ? ', ' : '、'),
                            })}
                          </span>
                        ) : null}
                      </span>
                      {active ? <IconCheckedOutline14 /> : null}
                    </button>
                  )
                })}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
