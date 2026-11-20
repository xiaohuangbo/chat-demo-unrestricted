import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import { RoleAvatar } from '../companion/RolePicker.js'
import { readAvatar } from '../../services/profile.js'
import {
  BASIC_ROLE_ID,
  addRole,
  removeRole,
  updateRole,
  useRoles,
  type Role,
} from '../../services/companion.js'
import styles from './RolesSettings.module.css'

/**
 * 设置 → 角色：角色卡列表与编辑。
 *
 * 角色是一套可复用的人设（昵称、性别、提示词、头像、自动记忆），
 * 会话在输入栏里选择角色；默认 DeepSeek 角色保持原生风格。
 */
export const RolesSettings = () => {
  const t = useTranslate()
  const roles = useRoles((state) => state.roles)
  const [editing, setEditing] = useState<Role | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const isDefault = editing?.id === BASIC_ROLE_ID

  const startCreate = () => {
    setAvatarError(false)
    setEditing({
      id: '',
      name: '',
      gender: '',
      prompt: '',
      avatar: '',
      auto: false,
    })
  }

  const save = () => {
    if (!editing) {
      return
    }
    const name = editing.name.trim()
    if (!name) {
      showToast({ key: 'roleNameRequired', type: 'error' })
      return
    }
    if (editing.id === '') {
      addRole({ ...editing, name })
    } else {
      updateRole(editing.id, { ...editing, name })
    }
    setEditing(null)
    showToast({ key: 'roleSaved' })
  }

  const pickAvatar = async (file: File) => {
    try {
      const avatar = await readAvatar(file)
      setEditing((current) => (current ? { ...current, avatar } : current))
      setAvatarError(false)
    } catch {
      setAvatarError(true)
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <div className={styles.title}>{t('rolesTitle')}</div>
          <div className={styles.hint}>{t('rolesHint')}</div>
        </div>
        <Button size="s" onClick={startCreate}>
          {t('roleCreate')}
        </Button>
      </div>

      <div className={styles.list}>
        {roles.map((role) => (
          <div
            key={role.id}
            className={styles.row}
            data-basic={role.id === BASIC_ROLE_ID || undefined}
          >
            <RoleAvatar role={role} size={38} />
            <div className={styles.main}>
              <div className={styles.name}>
                {role.name}
                {role.id === BASIC_ROLE_ID ? (
                  <span className={styles.badge}>{t('roleDefaultBadge')}</span>
                ) : null}
                {role.auto ? <span className={styles.badge}>{t('roleAutoMemory')}</span> : null}
              </div>
              <div className={styles.meta}>
                {role.id === BASIC_ROLE_ID
                  ? t('roleBasicHint')
                  : [role.gender, role.prompt.trim().slice(0, 60)].filter(Boolean).join(' · ') ||
                    t('roleCompanionHint')}
              </div>
            </div>
            <div className={styles.actions}>
              <Button
                size="s"
                variant="outlined"
                onClick={() => {
                  setAvatarError(false)
                  setEditing({ ...role })
                }}
              >
                {t('roleEdit')}
              </Button>
              {role.id !== BASIC_ROLE_ID ? (
                confirmDelete === role.id ? (
                  <Button
                    size="s"
                    variant="dangerOutlined"
                    onClick={() => {
                      removeRole(role.id)
                      setConfirmDelete(null)
                      showToast({ key: 'roleDeleted' })
                    }}
                  >
                    {t('roleDeleteConfirm')}
                  </Button>
                ) : (
                  <Button
                    size="s"
                    variant="dangerOutlined"
                    onClick={() => setConfirmDelete(role.id)}
                  >
                    {t('roleDelete')}
                  </Button>
                )
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {editing ? (
        <Modal
          title={editing.id === '' ? t('roleCreateTitle') : t('roleEditTitle')}
          closable
          onClose={() => setEditing(null)}
          footer={
            <div className={styles.modalFooter}>
              <Button variant="outlined" onClick={() => setEditing(null)}>
                {t('cancel')}
              </Button>
              <Button disabled={editing.name.trim() === ''} onClick={save}>
                {t('save')}
              </Button>
            </div>
          }
        >
          <div className={styles.editor}>
            <div className={styles.avatarRow}>
              <button
                type="button"
                className={styles.avatarButton}
                aria-label={t('roleAvatar')}
                onClick={() => fileRef.current?.click()}
              >
                <RoleAvatar role={{ ...editing, name: editing.name || '?' }} size={56} />
                <span>{t('roleAvatarEdit')}</span>
              </button>
              {editing.avatar ? (
                <button
                  type="button"
                  className={styles.textLink}
                  onClick={() => setEditing({ ...editing, avatar: '' })}
                >
                  {t('roleAvatarRemove')}
                </button>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                hidden
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) {
                    void pickAvatar(file)
                  }
                }}
              />
            </div>
            {avatarError ? <div className={styles.error}>{t('profileAvatarError')}</div> : null}

            <label className={styles.field}>
              <span>{t('roleName')}</span>
              <input
                maxLength={40}
                value={editing.name}
                placeholder={t('roleNamePlaceholder')}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
            </label>
            {!isDefault ? (
              <>
                <label className={styles.field}>
                  <span>{t('roleGender')}</span>
                  <input
                    maxLength={30}
                    value={editing.gender}
                    placeholder={t('roleGenderPlaceholder')}
                    onChange={(event) => setEditing({ ...editing, gender: event.target.value })}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('rolePrompt')}</span>
                  <textarea
                    rows={7}
                    maxLength={3000}
                    value={editing.prompt}
                    placeholder={t('rolePromptPlaceholder')}
                    onChange={(event) => setEditing({ ...editing, prompt: event.target.value })}
                  />
                  <span className={styles.count}>{editing.prompt.length} / 3000</span>
                </label>
                <div className={styles.hint}>{t('rolePromptHint')}</div>
              </>
            ) : (
              <div className={styles.hint}>{t('roleBasicHint')}</div>
            )}

            <div className={styles.switchRow}>
              <div>
                <div className={styles.switchLabel}>{t('roleAutoMemory')}</div>
                <div className={styles.hint}>{t('roleAutoMemoryHint')}</div>
              </div>
              <Switch
                checked={editing.auto}
                onChange={(value) => setEditing({ ...editing, auto: value })}
                label={t('roleAutoMemory')}
              />
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
