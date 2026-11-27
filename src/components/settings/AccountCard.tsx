import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { useSettings } from '../../services/settings.js'
import { useProfile } from '../../services/profile.js'
import {
  applyAccountNickname,
  refreshAccount,
  signInAccount,
  signOutAccount,
  useAccount,
} from '../../services/account/session.js'
import { setSettingsSection } from './settingsDialogState.js'
import styles from './AccountCard.module.css'

const formatSignedInAt = (time: number | null): string => {
  if (!time) {
    return '—'
  }
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 设置 → 数据管理：DeepSeek 账号。
 *
 * 登录用账号的 API Key（平台账号 OAuth 需要宿主回调，静态站点做不了，见 services/account/session.ts），
 * 登录后与「我的资料」「账户与用量」联动：昵称/头像共用一份，「同步到我的资料」把账号昵称填进资料，
 * 余额由账户与用量页读取同一个 Key。
 */
export const AccountCard = () => {
  const t = useTranslate()
  const account = useAccount()
  const profile = useProfile()
  const apiKey = useSettings((state) => state.apiKey)
  const [loginOpen, setLoginOpen] = useState(false)
  const signedIn = account.status === 'signed-in'
  const balanceText = account.profile
    ? `${account.profile.currency === 'USD' ? '$' : '¥'}${account.profile.total || '0'}`
    : '—'

  return (
    <>
      <section className={styles.card} data-account-card data-signed-in={signedIn || undefined}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{t('accountCardTitle')}</div>
            <div className={styles.hint}>{t('accountCardHint')}</div>
          </div>
          <span className={styles.badge} data-on={signedIn || undefined}>
            {signedIn ? t('accountSignedInStatus') : t('accountSignedOutStatus')}
          </span>
        </div>
        {signedIn && account.profile ? (
          <>
            <div className={styles.body}>
              <span className={styles.avatar}>
                {profile.avatar ? <img alt="" src={profile.avatar} /> : profile.name.slice(0, 1)}
              </span>
              <div className={styles.meta}>
                <div className={styles.name}>{profile.name}</div>
                <div className={styles.line}>
                  {t('accountKeyTail', { tail: account.profile.tail })}
                  <span className={styles.dot} aria-hidden />
                  {account.profile.available
                    ? t('accountBalance', { balance: balanceText })
                    : t('accountBalanceUnavailable')}
                </div>
                <div className={styles.line}>
                  {t('accountSignedInAt', { time: formatSignedInAt(account.signedInAt) })}
                </div>
              </div>
            </div>
            <div className={styles.actions}>
              <Button
                variant="outlined"
                size="s"
                onClick={async () => {
                  const ok = await refreshAccount()
                  ok
                    ? showToast({ key: 'accountRefreshDone' })
                    : showToast({ key: 'accountRefreshFailed', type: 'error' })
                }}
              >
                {t('accountRefresh')}
              </Button>
              <Button
                variant="outlined"
                size="s"
                onClick={() => {
                  if (applyAccountNickname()) {
                    showToast({ key: 'accountSyncNicknameDone' })
                  }
                }}
              >
                {t('accountSyncNickname')}
              </Button>
              <Button
                variant="outlined"
                size="s"
                onClick={() => {
                  setSettingsSection('general')
                }}
              >
                {t('accountEditProfile')}
              </Button>
              <Button
                variant="dangerOutlined"
                size="s"
                onClick={() => {
                  signOutAccount()
                  showToast({ key: 'accountSignOutDone' })
                }}
              >
                {t('accountSignOut')}
              </Button>
            </div>
            {account.error ? <div className={styles.error}>{t(account.error.key, account.error.params)}</div> : null}
          </>
        ) : (
          <>
            <div className={styles.actions}>
              <Button
                variant="primary"
                size="m"
                disabled={account.status === 'signing-in'}
                onClick={() => setLoginOpen(true)}
              >
                {account.status === 'signing-in' ? t('accountSigningIn') : t('accountSignIn')}
              </Button>
            </div>
            {account.error ? <div className={styles.error}>{t(account.error.key, account.error.params)}</div> : null}
          </>
        )}
      </section>
      {loginOpen ? (
        <AccountLoginModal
          apiKey={apiKey ?? ''}
          onClose={() => setLoginOpen(false)}
          onDone={() => setLoginOpen(false)}
        />
      ) : null}
    </>
  )
}

/** 登录弹窗：填 Key → 校验余额 → 登录态；Key 会存为本机 API Key（原来没有时） */
const AccountLoginModal = ({
  apiKey,
  onClose,
  onDone,
}: {
  apiKey: string
  onClose: () => void
  onDone: () => void
}) => {
  const t = useTranslate()
  const [value, setValue] = useState(apiKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const accountError = useAccount((state) => state.error)

  useEffect(() => {
    if (accountError && !busy) {
      setError(t(accountError.key, accountError.params))
    }
  }, [accountError, busy, t])

  const submit = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    const ok = await signInAccount(value)
    setBusy(false)
    if (ok) {
      showToast({ key: 'accountSignInDone' })
      onDone()
    }
  }

  return (
    <Modal
      title={t('accountSignInTitle')}
      onClose={() => {
        if (!busy) {
          onClose()
        }
      }}
      footer={
        <>
          <Button variant="outlined" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? t('accountSigningIn') : t('accountSignInSubmit')}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <label className={styles.label} htmlFor="account-api-key">
          {t('accountSignInKeyLabel')}
        </label>
        <input
          id="account-api-key"
          className={styles.input}
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-…"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void submit()
            }
          }}
        />
        <div className={styles.hint}>{t('accountSignInHint')}</div>
        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    </Modal>
  )
}
