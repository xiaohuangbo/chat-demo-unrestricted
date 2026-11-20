import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconRobotOutline16,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSessionRole, useChatStore } from '../../services/chat/store.js'
import { BASIC_ROLE_ID, setActiveRole, useRoles, type Role } from '../../services/companion.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { showToast } from '../base/toastState.js'
import styles from './RolePicker.module.css'

/** 角色头像：有图显示图，没有时显示名字首字 */
export const RoleAvatar = ({ role, size = 20 }: { role: Role; size?: number }) => (
  <span className={styles.avatar} style={{ width: size, height: size, fontSize: size * 0.5 }}>
    {role.avatar ? <img alt="" src={role.avatar} /> : role.name.slice(0, 1)}
  </span>
)

/**
 * 输入栏的角色选择：当前会话绑定的角色，或新会话的默认角色。
 * 只做选择与跳转管理，编辑在设置 → 角色里完成。
 */
export const RolePicker = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const roles = useRoles((state) => state.roles)
  const activeId = useRoles((state) => state.activeId)
  const sessionRoleId = useChatStore((state) =>
    sessionId === null ? undefined : state.sessionCache[sessionId]?.roleId
  )
  const current =
    roles.find((role) => role.id === (sessionId === null ? activeId : sessionRoleId)) ?? roles[0]
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'start',
    offset: 8,
    maxHeight: 320,
    minSpace: 200,
    measureKey: roles.length,
  })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const choose = (role: Role) => {
    setActiveRole(role.id)
    if (sessionId !== null) {
      setSessionRole(sessionId, role.id)
    }
    setOpen(false)
    showToast({
      key: 'roleSwitched',
      params: { role: role.id === BASIC_ROLE_ID ? 'DeepSeek' : role.name },
    })
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open)}
        aria-label={`${t('roleLabel')}: ${current.name}`}
        title={`${t('roleLabel')}: ${current.name}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconRobotOutline16 />
        <span className={styles.name}>{current.name}</span>
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
              role="listbox"
              aria-label={t('roleLabel')}
            >
              <div className={styles.head}>
                <span>{t('roleLabel')}</span>
                <button
                  type="button"
                  className={styles.manage}
                  onClick={() => {
                    setOpen(false)
                    openSettings('roles')
                  }}
                >
                  {t('roleManage')}
                </button>
              </div>
              {roles.map((role) => {
                const selected = current.id === role.id
                return (
                  <button
                    key={role.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={clsx(styles.option, selected && styles.active)}
                    onClick={() => choose(role)}
                  >
                    <RoleAvatar role={role} size={24} />
                    <span className={styles.optionMain}>
                      <span className={styles.optionName}>{role.name}</span>
                      <span className={styles.optionHint}>
                        {role.id === BASIC_ROLE_ID
                          ? t('roleBasicHint')
                          : role.gender || t('roleCompanionHint')}
                      </span>
                    </span>
                    {selected ? <IconCheckedOutline14 /> : null}
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
