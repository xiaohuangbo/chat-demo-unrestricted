import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import {
  avatarFileAllowed,
  setProfileAvatar,
  setProfileName,
  useProfile,
} from '../../services/profile.js'
import { applyAccountNickname, useAccount } from '../../services/account/session.js'
import { setSettingsSection } from './settingsDialogState.js'
import { AvatarCropModal } from './AvatarCropModal.js'
import styles from './ProfileCard.module.css'

/** 通用设置 → 我的资料：昵称与头像只存本机，昵称作为「用户称呼」注入 system。 */
export const ProfileCard = () => {
  const t = useTranslate()
  const profile = useProfile()
  const account = useAccount()
  const signedIn = account.status === 'signed-in'
  const [name, setName] = useState(profile.name)
  const [avatarError, setAvatarError] = useState(false)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirty = name.trim() !== profile.name && name.trim() !== ''

  useEffect(() => {
    setName(profile.name)
  }, [profile.name])

  const save = () => {
    if (!name.trim()) {
      return
    }
    setProfileName(name)
    showToast({ key: 'profileSaved' })
  }

  return (
    <>
      <section className={styles.card}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{t('profileTitle')}</div>
            <div className={styles.hint}>{t('profileHint')}</div>
          </div>
        </div>
        <div className={styles.accountRow} data-profile-account>
          <span className={styles.accountLabel}>{t('profileAccountLabel')}</span>
          {signedIn ? (
            <>
              <span className={styles.accountName}>
                {t('accountKeyTail', { tail: account.profile?.tail ?? '' })}
              </span>
              <button
                type="button"
                className={styles.accountAction}
                onClick={() => {
                  if (applyAccountNickname()) {
                    showToast({ key: 'accountSyncNicknameDone' })
                  }
                }}
              >
                {t('accountSyncNickname')}
              </button>
              <button
                type="button"
                className={styles.accountAction}
                onClick={() => setSettingsSection('data')}
              >
                {t('accountManage')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.accountSignIn}
              onClick={() => setSettingsSection('data')}
            >
              {t('accountSignIn')}
            </button>
          )}
        </div>
        <div className={styles.body}>
          <button
            type="button"
            className={styles.avatarButton}
            aria-label={t('profileAvatar')}
            onClick={() => fileRef.current?.click()}
          >
            {profile.avatar ? (
              <img alt="" src={profile.avatar} />
            ) : (
              <span>{profile.name.slice(0, 1)}</span>
            )}
            <span className={styles.avatarBadge}>{t('profileAvatarEdit')}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) {
                return
              }
              if (!avatarFileAllowed(file)) {
                setAvatarError(true)
                return
              }
              setAvatarError(false)
              setCropFile(file)
            }}
          />
          <div className={styles.nameArea}>
            <label className={styles.label} htmlFor="profile-name">
              {t('profileName')}
            </label>
            <div className={styles.nameRow}>
              <input
                id="profile-name"
                maxLength={32}
                value={name}
                placeholder={t('profileNamePlaceholder')}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    save()
                  }
                }}
              />
              <Button size="s" disabled={!dirty} onClick={save}>
                {t('save')}
              </Button>
            </div>
            <div className={styles.hint}>{t('profileNameHint')}</div>
            {profile.avatar ? (
              <button type="button" className={styles.remove} onClick={() => setProfileAvatar('')}>
                {t('profileAvatarRemove')}
              </button>
            ) : null}
            {avatarError ? <div className={styles.error}>{t('profileAvatarError')}</div> : null}
          </div>
        </div>
      </section>
      {cropFile ? (
        <AvatarCropModal
          file={cropFile}
          onClose={() => setCropFile(null)}
          onConfirm={(dataUrl) => {
            setProfileAvatar(dataUrl)
            setCropFile(null)
            showToast({ key: 'profileAvatarSaved' })
          }}
        />
      ) : null}
    </>
  )
}
