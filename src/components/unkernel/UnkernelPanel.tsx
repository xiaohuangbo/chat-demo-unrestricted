import { useEffect, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16, IconSettingsOutline16 } from '../base/icons.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { consumePendingUnkernelBoot } from '../../services/webvm/coi.js'
import { useUnkernelConfig, unkernelUrl } from '../../services/unkernel/config.js'
import {
  attachUnkernelFrame,
  closeUnkernel,
  detachUnkernelFrame,
  openUnkernel,
  useUnkernel,
} from '../../services/unkernel/session.js'
import styles from './Unkernel.module.css'

/**
 * unkernel 的 iframe 宿主。
 *
 * 页面保留挂载：关闭只是隐藏，Linux 和终端窗口继续运行；改设置会换
 * iframe URL（然后重启这台虚拟机）。页面里的 window.KW.vm 与父页面同源，
 * Agent 工具和工作区挂载都通过它访问。
 */
export const UnkernelPanel = () => {
  const t = useTranslate()
  const mounted = useUnkernel((state) => state.mounted)
  const open = useUnkernel((state) => state.open)
  const status = useUnkernel((state) => state.status)
  const error = useUnkernel((state) => state.error)
  const workspaceMounted = useUnkernel((state) => state.workspaceMounted)
  const restartKey = useUnkernel((state) => state.restartKey)
  const config = useUnkernelConfig()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (consumePendingUnkernelBoot()) {
      openUnkernel()
    }
  }, [])

  useEffect(() => {
    if (!mounted) {
      return
    }
    const frame = iframeRef.current
    if (!frame) {
      return
    }
    const onLoad = () => attachUnkernelFrame(frame)
    if (frame.contentDocument?.readyState === 'complete') {
      onLoad()
    } else {
      frame.addEventListener('load', onLoad)
    }
    return () => {
      frame.removeEventListener('load', onLoad)
      detachUnkernelFrame()
    }
  }, [mounted, config, restartKey])

  if (!mounted) {
    return null
  }

  const statusText =
    status === 'ready'
      ? workspaceMounted
        ? t('unkernelStatusReady')
        : t('unkernelStatusReadyNoWorkspace')
      : status === 'loading'
        ? t('unkernelStatusLoading')
        : status === 'error'
          ? t('unkernelStatusError', { reason: error ?? '—' })
          : t('unkernelStatusIdle')

  return (
    <div className={styles.overlay} data-open={open ? 'true' : 'false'} aria-hidden={!open}>
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.dot} data-status={status} aria-hidden />
          <span>{t('unkernelTitle')}</span>
          <span className={styles.status}>{statusText}</span>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.config} onClick={() => openSettings('unkernel')}>
            {t('unkernelConfig')}
          </button>
          <IconButton
            size="xs"
            icon={<IconSettingsOutline16 />}
            tooltip={t('unkernelConfig')}
            onClick={() => openSettings('unkernel')}
          />
          <IconButton
            size="xs"
            icon={<IconCloseOutline16 />}
            tooltip={t('unkernelClose')}
            onClick={closeUnkernel}
          />
        </div>
      </div>
      <iframe
        key={restartKey}
        ref={iframeRef}
        className={styles.frame}
        title={t('unkernelTitle')}
        src={unkernelUrl(config)}
        allow="clipboard-read; clipboard-write; microphone; fullscreen"
      />
    </div>
  )
}
