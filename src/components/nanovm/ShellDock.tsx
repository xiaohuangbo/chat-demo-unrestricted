import clsx from 'clsx'
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16, IconTerminalOutline16, IconTrashOutline16 } from '../base/icons.js'
import { loadEngine, useEngine } from '../../services/nanovm/boot.js'
import { useNanoVMConfig } from '../../services/nanovm/config.js'
import { clearNanoVMScreen, closeNanoVM, useNanoVM } from '../../services/nanovm/session.js'
import { clearWebVmScreen } from '../../services/webvm/session.js'
import { useWebVMConfig } from '../../services/webvm/config.js'
import { ResetVmDialog } from './ResetVmDialog.js'
import { mbText, useVmUsage } from './usage.js'
import { ShellTabs } from './ShellTabs.js'
import { TerminalView } from './TerminalView.js'
import { VmSwitcher } from './VmSwitcher.js'
import styles from './NanoVM.module.css'

const WebVmTerminal = lazy(() =>
  import('../webvm/WebVmTerminal.js').then((module) => ({ default: module.WebVmTerminal }))
)

/** 停靠宽度：默认 420px，可拖到 320px ~ 视口的 70% */
const WIDTH_KEY = 'chat-demo:nanovm-dock-width'
const DEFAULT_WIDTH = 420
const MIN_WIDTH = 320
const MAX_RATIO = 0.7

const maxWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * MAX_RATIO))

const clampWidth = (value: number) => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(value)))

/** 读回上次拖出来的宽度，坏数据回落到默认值 */
const readWidth = () => {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) ? clampWidth(value) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

const writeWidth = (value: number) => {
  try {
    localStorage.setItem(WIDTH_KEY, String(value))
  } catch {
    // 隐私模式写不进去，本次会话照常使用
  }
}

/**
 * 桌面端右侧停靠：作为 .workspace 的第二个 flex 子元素挤压聊天区。
 * 左边缘 4px 的拖拽条改宽度，宽度记在 localStorage；
 * desktopDock 关闭时改成 absolute 浮层，不挤压聊天。
 */
export const ShellDock = () => {
  const t = useTranslate()
  const tabs = useNanoVM((state) => state.tabs)
  const activeId = useNanoVM((state) => state.activeId)
  const activeVm = useNanoVM((state) => state.activeVm)
  const webvmEnabled = useWebVMConfig((state) => state.enabled)
  const docked = useNanoVMConfig((state) => state.desktopDock)
  const memoryMB = useNanoVMConfig((state) => state.memoryMB)
  const status = useEngine((state) => state.status)
  const info = useEngine((state) => state.info)
  const error = useEngine((state) => state.error)
  const usage = useVmUsage()

  const tab = tabs.find((item) => item.id === activeId) ?? tabs[0]
  const [width, setWidth] = useState(readWidth)
  const widthRef = useRef(width)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [webvmMounted, setWebvmMounted] = useState(activeVm === 'webvm')

  // WebVM 第一次打开后保持挂载：切到 NanoVM 只是 CSS 隐藏，滚动历史与输入都还在
  useEffect(() => {
    if (activeVm === 'webvm') {
      setWebvmMounted(true)
    }
  }, [activeVm])

  // 窗口变窄时把宽度收回视口 70% 以内
  useEffect(() => {
    const onResize = () => {
      const next = clampWidth(widthRef.current)
      if (next !== widthRef.current) {
        widthRef.current = next
        setWidth(next)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 拖拽期间锁住光标，避免划过聊天区时变成文本选择
  useEffect(() => {
    if (!resizing) {
      return
    }
    const previous = document.body.style.cursor
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = previous
      document.body.style.userSelect = ''
    }
  }, [resizing])

  const resizeTo = (value: number) => {
    const next = clampWidth(value)
    widthRef.current = next
    setWidth(next)
  }

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: widthRef.current }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) {
      return
    }
    resizeTo(drag.startWidth + (drag.startX - event.clientX))
  }

  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return
    }
    dragRef.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    writeWidth(widthRef.current)
  }

  const statusText =
    status === 'loading'
      ? t('nanovmStatusLoading')
      : status === 'error'
        ? t('nanovmStatusError', { reason: error ?? '—' })
        : status === 'ready'
          ? t('nanovmStatusReady', {
              applets: info?.applets ?? 0,
              memory: info?.wasmMemoryMB ?? memoryMB,
            })
          : ''

  const usageText = t('nanovmUsage', {
    files: usage.files,
    used: mbText(usage.bytes),
    total: usage.diskMB,
  })

  return (
    <section
      className={clsx(styles.dock, docked ? styles.dockDocked : styles.dockFloating)}
      style={{ width }}
      role="complementary"
      aria-label={t('nanovm')}
    >
      <div
        className={clsx(styles.resizer, resizing && styles.resizerActive)}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('nanovm')}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={() => {
          resizeTo(DEFAULT_WIDTH)
          writeWidth(DEFAULT_WIDTH)
        }}
      />
      <header className={styles.dockHead}>
        <div className={styles.dockTitle}>
          <IconTerminalOutline16 />
          <span>{activeVm === 'webvm' ? t('webvmTitle') : t('nanovm')}</span>
        </div>
        <div className={styles.dockActions}>
          {activeVm === 'nanovm' ? (
            <button type="button" className={styles.headReset} onClick={() => setResetOpen(true)}>
              {t('nanovmResetShort')}
            </button>
          ) : null}
          <IconButton
            size="xs"
            tooltip={t('nanovmClear')}
            icon={<IconTrashOutline16 />}
            disabled={activeVm === 'nanovm' && tab.lines.length === 0}
            onClick={() => (activeVm === 'webvm' ? clearWebVmScreen() : clearNanoVMScreen())}
          />
          <IconButton
            size="xs"
            tooltip={t('nanovmCollapse')}
            icon={<IconCloseOutline16 />}
            onClick={closeNanoVM}
          />
        </div>
      </header>
      <VmSwitcher variant="dock" />
      {activeVm === 'nanovm' ? (
        <>
          <ShellTabs variant="dock" />
          <div className={styles.dockStatus}>
            <span className={styles.statusDot} data-status={status} aria-hidden />
            <span className={styles.statusText}>{statusText}</span>
            {status === 'error' ? (
              <button
                type="button"
                className={styles.statusRetry}
                onClick={() => void loadEngine()}
              >
                {t('nanovmRetry')}
              </button>
            ) : null}
            <span className={styles.statusUsage}>{usageText}</span>
          </div>
          <TerminalView tab={tab} />
        </>
      ) : null}
      {webvmMounted && webvmEnabled ? (
        <div className={clsx(styles.vmPane, activeVm !== 'webvm' && styles.vmPaneHidden)}>
          <Suspense fallback={<div className={styles.paneLoading}>{t('webvmStatusLoading')}</div>}>
            <WebVmTerminal visible={activeVm === 'webvm'} />
          </Suspense>
        </div>
      ) : null}
      {resetOpen ? <ResetVmDialog onClose={() => setResetOpen(false)} /> : null}
    </section>
  )
}
