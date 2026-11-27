import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconBookOutline16,
  IconChipOutline16,
  IconCloseOutline16,
  IconGlobeLanguageOutline14,
  IconPanelLeftOutline16,
  IconPinOutline16,
  IconSettingsOutline16,
  IconTerminalOutline16,
  IconThinkOutline16,
  IconTrashOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import {
  newChat,
  removeSession,
  removeSessions,
  setSessionsPinned,
  useChatStore,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeLab, openLab, useLab } from '../../services/lab/labStore.js'
import { closeDocs, openDocs, useDocs } from '../../services/docs/docsStore.js'
import { toggleNanoVM, toggleWebVM, useNanoVM } from '../../services/nanovm/session.js'
import { useNanoVMConfig } from '../../services/nanovm/config.js'
import { useWebVMConfig } from '../../services/webvm/config.js'
import { useUnkernelConfig } from '../../services/unkernel/config.js'
import { openUnkernel, useUnkernel } from '../../services/unkernel/session.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import {
  exitSelecting,
  pruneSelected,
  setSelected,
  startSelecting,
  toggleSelected,
  useSessionSelection,
} from './sessionSelection.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const labOpen = useLab((state) => state.open)
  const docsOpen = useDocs((state) => state.open)
  const nanoVMEnabled = useNanoVMConfig((state) => state.enabled)
  const webVMEnabled = useWebVMConfig((state) => state.enabled)
  const unkernelEnabled = useUnkernelConfig((state) => state.enabled)
  const unkernelOpen = useUnkernel((state) => state.open)
  const nanoVMOpen = useNanoVM((state) => state.open)
  const activeVm = useNanoVM((state) => state.activeVm)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const selection = useSessionSelection()
  const selecting = selection.active
  const selectedIds = useMemo(() => new Set(selection.ids), [selection.ids])
  const selectedSessions = useMemo(
    () => sessions.filter((session) => selectedIds.has(session.id)),
    [sessions, selectedIds]
  )
  const allPinned = selectedSessions.length > 0 && selectedSessions.every((s) => s.pinned)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [bulkPending, setBulkPending] = useState(false)

  // 会话被删除或导入替换后，丢掉已经不存在的选择
  useEffect(() => {
    pruneSelected(sessions.map((session) => session.id))
  }, [sessions])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      {selecting ? (
        <div className={clsx(styles.top, styles.selectTop)}>
          <div className={styles.selectTitle} data-selection-header>
            {t('sessionSelectTitle', { count: selectedSessions.length })}
          </div>
          <div className={styles.selectActions}>
            <button
              type="button"
              className={styles.selectAll}
              onClick={() =>
                setSelected(
                  selectedSessions.length === sessions.length ? [] : sessions.map((s) => s.id)
                )
              }
            >
              {selectedSessions.length === sessions.length && sessions.length > 0
                ? t('sessionSelectNone')
                : t('sessionSelectAll')}
            </button>
            <IconButton
              size="m"
              icon={<IconCloseOutline16 />}
              tooltip={t('sessionSelectExit')}
              tooltipPlacement="bottom"
              onClick={exitSelecting}
            />
          </div>
        </div>
      ) : (
        <div className={styles.top}>
          <div className={styles.appName}>{t('appName')}</div>
          <IconButton
            size="m"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
          />
        </div>
      )}
      {selecting ? null : (
        <button
          type="button"
          className={styles.newChat}
          onClick={() => {
            closeLab()
            newChat()
            closeMobileSider()
          }}
        >
          <span className={styles.newChatIcon}>
            <NewChatIcon />
          </span>
          {t('newChat')}
        </button>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader} data-group={group.key}>
                {group.label}
              </div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  selecting={selecting}
                  selected={selectedIds.has(session.id)}
                  onDelete={() => setDeleting(session)}
                  onToggleSelect={() => toggleSelected(session.id)}
                  onStartSelecting={() => startSelecting(session.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {selecting ? (
        <div className={styles.bulkBar} data-bulk-bar>
          <button
            type="button"
            className={styles.bulkAction}
            data-bulk="pin"
            disabled={!selectedSessions.length}
            onClick={() => {
              const pinned = !allPinned
              const changed = setSessionsPinned(selection.ids, pinned)
              if (changed) {
                showToast(
                  pinned
                    ? t('sessionPinnedCountToast', { count: changed })
                    : t('sessionUnpinnedCountToast', { count: changed })
                )
                exitSelecting()
              }
            }}
          >
            <IconPinOutline16 />
            {allPinned ? t('sessionUnpinSelected') : t('sessionPinSelected')}
          </button>
          <span className={styles.bulkDivider} aria-hidden />
          <button
            type="button"
            className={clsx(styles.bulkAction, styles.bulkDanger)}
            data-bulk="delete"
            disabled={!selectedSessions.length}
            onClick={() => setBulkDeleteOpen(true)}
          >
            <IconTrashOutline16 />
            {t('delete')}
          </button>
        </div>
      ) : (
      <div className={styles.bottom}>
        <button
          type="button"
          className={clsx(styles.settings, docsOpen && styles.settingsActive)}
          onClick={() => {
            if (docsOpen) {
              closeDocs()
            } else {
              closeLab()
              openDocs()
            }
            if (mobile) {
              closeMobileSider()
            }
          }}
        >
          <span className={styles.settingsIcon}>
            <IconBookOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('docsEntry')}</span>
        </button>
        {nanoVMEnabled ? (
          <button
            type="button"
            className={clsx(
              styles.settings,
              nanoVMOpen && activeVm === 'nanovm' && styles.settingsActive
            )}
            onClick={() => {
              toggleNanoVM()
              if (mobile) {
                closeMobileSider()
              }
            }}
          >
            <span className={styles.settingsIcon}>
              <IconTerminalOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('nanovm')}</span>
          </button>
        ) : null}
        {webVMEnabled ? (
          <button
            type="button"
            className={clsx(
              styles.settings,
              nanoVMOpen && activeVm === 'webvm' && styles.settingsActive
            )}
            onClick={() => {
              toggleWebVM()
              if (mobile) {
                closeMobileSider()
              }
            }}
          >
            <span className={styles.settingsIcon}>
              <IconGlobeLanguageOutline14 />
            </span>
            <span className={styles.settingsLabel}>{t('webvm')}</span>
          </button>
        ) : null}
        {unkernelEnabled ? (
          <button
            type="button"
            className={clsx(styles.settings, unkernelOpen && styles.settingsActive)}
            onClick={() => {
              openUnkernel()
              if (mobile) {
                closeMobileSider()
              }
            }}
          >
            <span className={styles.settingsIcon}>
              <IconChipOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('unkernel')}</span>
          </button>
        ) : null}
        <button
          type="button"
          className={clsx(styles.settings, labOpen && styles.settingsActive)}
          onClick={() => {
            if (labOpen) {
              closeLab()
              return
            }
            closeDocs()
            openLab()
          }}
        >
          <span className={styles.settingsIcon}>
            <IconThinkOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('labEntry')}</span>
        </button>
        <button
          type="button"
          className={styles.settings}
          onClick={() => {
            closeMobileSider()
            openSettings('general')
          }}
        >
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      )}
      {bulkDeleteOpen ? (
        <Modal
          title={t('sessionBulkDeleteTitle', { count: selectedSessions.length })}
          onClose={() => {
            if (!bulkPending) {
              setBulkDeleteOpen(false)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={bulkPending}
                onClick={() => setBulkDeleteOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={bulkPending || !selectedSessions.length}
                onClick={async () => {
                  setBulkPending(true)
                  try {
                    const removed = await removeSessions(selection.ids)
                    setBulkDeleteOpen(false)
                    exitSelecting()
                    if (removed === selectedSessions.length) {
                      showToast(t('sessionBulkDeletedToast', { count: removed }))
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setBulkPending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('sessionBulkDeleteBody', { count: selectedSessions.length })}
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  // 抽屉常驻 DOM，用 transform / opacity 过渡滑入滑出；关闭时不可点击也不进焦点顺序
  return (
    <div className={clsx(styles.drawer, open && styles.drawerOpen)} aria-hidden={!open}>
      <Sider mobile />
    </div>
  )
}
