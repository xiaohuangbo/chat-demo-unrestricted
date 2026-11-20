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
import { showToast } from '../base/toastState.js'
import {
  IconChevronDownOutline14,
  IconCloseOutline16,
  IconKeyboardSwitch16,
  IconRightUpOutline14,
  IconSettingsOutline16,
  IconTerminalOutline16,
} from '../base/icons.js'
import {
  closeNanoVM,
  interruptNanoVM,
  setNanoVMExpanded,
  useNanoVM,
} from '../../services/nanovm/session.js'
import { showKeyboardPicker } from '../../services/nanovm/keyboard.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { ResetVmDialog } from './ResetVmDialog.js'
import { ShellTabs } from './ShellTabs.js'
import { TerminalView } from './TerminalView.js'
import { VmSwitcher } from './VmSwitcher.js'
import { useWebVMConfig } from '../../services/webvm/config.js'
import styles from './NanoVM.module.css'

const WebVmTerminal = lazy(() =>
  import('../webvm/WebVmTerminal.js').then((module) => ({ default: module.WebVmTerminal }))
)

/** 面板高度：默认 52%，可拖到 30%–92%，expanded 时固定 92% */
const DEFAULT_RATIO = 0.52
const MIN_RATIO = 0.3
const MAX_RATIO = 0.92
/** 可见区域比窗口矮这么多就认为软键盘弹开了（手机键盘通常 200px 以上） */
const KEYBOARD_GAP = 120
/** 键盘弹开时面板与可见区域顶端的缝隙 */
const KEYBOARD_INSET = 4
/** 视觉视口读数异常时的兜底高度，别让面板塌成一条线 */
const KEYBOARD_MIN_HEIGHT = 160

/**
 * 手机端底部面板：position: fixed 贴在底部，不影响页面布局。
 *
 * 键盘弹出时靠 visualViewport 把面板抬到键盘上方：可见区域明显变矮（软键盘）
 * 就让面板填满键盘上方的全部空间，键盘收起后回到用户拖出来的比例，
 * 这样 320×640 这种小屏敲命令时输出区也够高；顶部拖拽条在 30%–92% 之间改高度。
 */
export const ShellSheet = () => {
  const t = useTranslate()
  const tabs = useNanoVM((state) => state.tabs)
  const activeId = useNanoVM((state) => state.activeId)
  const activeVm = useNanoVM((state) => state.activeVm)
  const webvmEnabled = useWebVMConfig((state) => state.enabled)
  const expanded = useNanoVM((state) => state.expanded)
  const tab = tabs.find((item) => item.id === activeId) ?? tabs[0]
  const [ratio, setRatio] = useState(DEFAULT_RATIO)
  const [viewportHeight, setViewportHeight] = useState(
    () => window.visualViewport?.height ?? window.innerHeight
  )
  const [keyboardOffset, setKeyboardOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [webvmMounted, setWebvmMounted] = useState(activeVm === 'webvm')

  useEffect(() => {
    if (activeVm === 'webvm') {
      setWebvmMounted(true)
    }
  }, [activeVm])
  const dragRef = useRef<{ startY: number; startRatio: number } | null>(null)

  // 键盘弹出 / 页面被顶上去时，面板跟着视觉视口走
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      const height = viewport?.height ?? window.innerHeight
      const offsetTop = viewport?.offsetTop ?? 0
      setViewportHeight(Math.round(height))
      setKeyboardOffset(Math.max(0, Math.round(window.innerHeight - height - offsetTop)))
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  // 键盘弹开时面板直接铺满键盘上方，键盘收起后回到用户之前的比例
  const keyboardOpen = keyboardOffset > KEYBOARD_GAP
  const height = expanded
    ? Math.round(MAX_RATIO * viewportHeight)
    : keyboardOpen
      ? Math.max(KEYBOARD_MIN_HEIGHT, Math.round(viewportHeight - KEYBOARD_INSET))
      : Math.round(ratio * viewportHeight)

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 键盘开着时高度由键盘决定，拖拽条先歇着，免得拖了没反应
    if (keyboardOpen) {
      return
    }
    dragRef.current = { startY: event.clientY, startRatio: expanded ? MAX_RATIO : ratio }
    if (expanded) {
      setNanoVMExpanded(false)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) {
      return
    }
    const delta = (drag.startY - event.clientY) / Math.max(1, viewportHeight)
    setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, drag.startRatio + delta)))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) {
      return
    }
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <section
      className={clsx(styles.sheet, dragging && styles.sheetDragging)}
      style={{ bottom: keyboardOffset, height }}
      data-keyboard={keyboardOpen ? 'open' : 'closed'}
      role="dialog"
      aria-label={t('nanovm')}
    >
      <div
        className={styles.sheetGrip}
        role="separator"
        aria-orientation="horizontal"
        aria-label={expanded ? t('nanovmRestore') : t('nanovmExpand')}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setNanoVMExpanded(!expanded)}
      />
      <div className={styles.sheetTop}>
        <VmSwitcher variant="sheet" />
        <span className={styles.sheetClose}>
          <IconButton
            size="xs"
            icon={<IconCloseOutline16 />}
            tooltip={t('nanovmClose')}
            onClick={closeNanoVM}
          />
        </span>
      </div>
      {/* 标签条单独占一行：它内部有 flex:1，直接放在纵向 sheet 里会被拉成几百像素高 */}
      {activeVm === 'nanovm' ? (
        <div className={styles.sheetTabRow}>
          <ShellTabs variant="sheet" />
        </div>
      ) : null}
      {activeVm === 'nanovm' ? (
        <div className={styles.sheetTools}>
          <button
            type="button"
            className={styles.interrupt}
            disabled={!tab.running}
            onClick={interruptNanoVM}
          >
            <span className={styles.interruptKey}>Ctrl+C</span>
            {t('nanovmInterrupt')}
          </button>
          <div className={styles.sheetToolRight}>
            <button type="button" className={styles.toolReset} onClick={() => setResetOpen(true)}>
              {t('nanovmResetShort')}
            </button>
            <button
              type="button"
              className={styles.toolLink}
              onClick={() => openSettings('nanovm')}
            >
              {t('nanovmConfig')}
            </button>
            <IconButton
              size="xs"
              icon={<IconSettingsOutline16 />}
              tooltip={t('nanovmConfig')}
              onClick={() => openSettings('nanovm')}
            />
          </div>
        </div>
      ) : null}
      {activeVm === 'nanovm' ? (
        <TerminalView
          tab={tab}
          compact
          renderInputActions={({ focus, toggleKeyboard }) => (
            <>
              {/* 先聚焦输入框再叫原生选择器，键盘已经弹着时也能立刻换 */}
              <button
                type="button"
                className={styles.inputButton}
                aria-label={t('nanovmKeyboardSwitch')}
                title={t('nanovmKeyboardHint')}
                onClick={() => {
                  focus()
                  if (!showKeyboardPicker()) {
                    showToast({ key: 'nanovmKeyboardUnavailable' })
                  }
                }}
              >
                <IconKeyboardSwitch16 />
              </button>
              <IconButton
                size="xs"
                icon={<IconTerminalOutline16 />}
                tooltip={t('nanovmKeyboard')}
                onClick={toggleKeyboard}
              />
              <IconButton
                size="xs"
                icon={expanded ? <IconChevronDownOutline14 /> : <IconRightUpOutline14 />}
                tooltip={expanded ? t('nanovmRestore') : t('nanovmExpand')}
                onClick={() => setNanoVMExpanded(!expanded)}
              />
            </>
          )}
        />
      ) : null}
      {webvmMounted && webvmEnabled ? (
        <div
          className={clsx(
            styles.vmPane,
            styles.vmPaneSheet,
            activeVm !== 'webvm' && styles.vmPaneHidden
          )}
        >
          <Suspense fallback={<div className={styles.paneLoading}>{t('webvmStatusLoading')}</div>}>
            <WebVmTerminal visible={activeVm === 'webvm'} compact />
          </Suspense>
        </div>
      ) : null}
      {resetOpen ? <ResetVmDialog onClose={() => setResetOpen(false)} /> : null}
    </section>
  )
}
