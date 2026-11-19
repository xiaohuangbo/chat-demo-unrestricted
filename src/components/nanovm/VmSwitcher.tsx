import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useEngine } from '../../services/nanovm/boot.js'
import { setActiveVm, useNanoVM, type VmKind } from '../../services/nanovm/session.js'
import { useWebVMConfig } from '../../services/webvm/config.js'
import { useWebVM } from '../../services/webvm/session.js'
import styles from './NanoVM.module.css'

/** 状态点：把两个虚拟机的状态压成 ready / loading / error / idle 四档 */
const dotStatus = (value: string): 'ready' | 'loading' | 'error' | 'idle' => {
  if (value === 'ready') {
    return 'ready'
  }
  if (value === 'loading' || value === 'connecting' || value === 'booting') {
    return 'loading'
  }
  if (value === 'error') {
    return 'error'
  }
  return 'idle'
}

/**
 * NanoVM / WebVM 的切换器。
 *
 * 切换只改 useNanoVM.activeVm，不销毁任何实例：NanoVM 的 WASM 引擎和
 * WebVM 的 CheerpX 进程都留在内存里，切回来时终端与文件还在。
 */
export const VmSwitcher = ({ variant }: { variant: 'dock' | 'sheet' }) => {
  const t = useTranslate()
  const active = useNanoVM((state) => state.activeVm)
  const nanoStatus = useEngine((state) => state.status)
  const webStatus = useWebVM((state) => state.status)
  const webEnabled = useWebVMConfig((state) => state.enabled)

  const items: { id: VmKind; label: string; status: string }[] = [
    { id: 'nanovm', label: t('nanovm'), status: nanoStatus },
    ...(webEnabled ? [{ id: 'webvm' as const, label: t('webvm'), status: webStatus }] : []),
  ]

  return (
    <div
      className={clsx(styles.vmSwitch, variant === 'sheet' && styles.vmSwitchSheet)}
      role="tablist"
      aria-label={t('webvmSwitch')}
      title={t('webvmSwitchHint')}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === active}
          className={clsx(styles.vmSwitchButton, item.id === active && styles.vmSwitchActive)}
          onClick={() => setActiveVm(item.id)}
        >
          <span className={styles.vmSwitchDot} data-status={dotStatus(item.status)} aria-hidden />
          <span className={styles.vmSwitchLabel}>{item.label}</span>
          {item.id === 'webvm' ? <span className={styles.vmSwitchTag}>x86</span> : null}
        </button>
      ))}
    </div>
  )
}
