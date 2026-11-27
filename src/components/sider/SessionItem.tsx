import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconBranchOutline16,
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPinOutline16,
  IconSelectOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import {
  forkSession,
  renameSession,
  selectSession,
  setSessionPinned,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import { showToast } from '../base/toastState.js'
import styles from './SessionItem.module.css'

/**
 * 一个会话：普通状态点开进入会话、右侧「…」菜单；多选状态下整行变成勾选行，
 * 点一下切换选中，不再打开会话（与官方客户端一致）。
 */
export const SessionItem = memo(function SessionItem({
  session,
  active,
  selecting,
  selected,
  onDelete,
  onToggleSelect,
  onStartSelecting,
}: {
  session: SessionSummary
  active: boolean
  selecting: boolean
  selected: boolean
  onDelete: () => void
  onToggleSelect: () => void
  onStartSelecting: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  const togglePinned = () => {
    setSessionPinned(session.id, !session.pinned)
    showToast(session.pinned ? t('sessionUnpinnedToast') : t('sessionPinnedToast'))
  }

  return (
    <div
      className={clsx(
        styles.item,
        active && !selecting && styles.active,
        selecting && styles.selectable,
        selected && styles.selected
      )}
      role={selecting ? 'option' : undefined}
      aria-selected={selecting ? selected : undefined}
      data-session-id={session.id}
      data-pinned={session.pinned ? '1' : undefined}
      data-selected={selecting && selected ? '1' : undefined}
      onClick={() => {
        if (selecting) {
          onToggleSelect()
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      {selecting ? (
        <span className={clsx(styles.check, selected && styles.checkOn)} aria-hidden>
          {selected ? <IconCheckOutline16 /> : null}
        </span>
      ) : null}
      <div className={styles.title}>{displayTitle}</div>
      {session.pinned && !selecting ? (
        <span className={styles.pinMark} aria-label={t('sessionPinnedLabel')}>
          <IconPinOutline16 />
        </span>
      ) : null}
      {selecting ? null : (
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            options={[
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'pin',
                label: session.pinned ? t('sessionItemMenuUnpinOption') : t('sessionItemMenuPinOption'),
                icon: <IconPinOutline16 />,
                onSelect: togglePinned,
              },
              {
                key: 'select',
                label: t('sessionItemMenuSelectOption'),
                icon: <IconSelectOutline16 />,
                onSelect: onStartSelecting,
              },
              {
                key: 'fork',
                label: t('forkToNewChat'),
                icon: <IconBranchOutline16 />,
                onSelect: () => {
                  if (forkSession(session.id)) {
                    closeMobileSider()
                    showToast({ key: 'forkCreated' })
                  } else {
                    showToast({ key: 'forkFailed' })
                  }
                },
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})
