import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { useApiKeyEditor } from './ApiKeyField.js'
import { setSettingsSection } from './settingsDialogState.js'
import { fetchBalance, type AccountBalance } from '../../services/api/balance.js'
import { ApiError } from '../../services/api/client.js'
import { useDailyUsage } from '../../services/chat/dailyUsage.js'
import { totalVoiceUsage } from '../../services/chat/sessionStats.js'
import { formatMoney, formatTokens } from '../../services/chat/sessionStats.js'
import { ledgerSeries, ledgerTotals, useLedger } from '../../services/chat/usageLedger.js'
import styles from './AccountSettings.module.css'

/**
 * 设置 → 账户与用量：API Key 所属账户的余额、今日用量与近 30 天汇总。
 * 数字全部来自每日用量与用量账本，和「统计」页保持一致。
 */
export const AccountSettings = () => {
  const t = useTranslate()
  const editor = useApiKeyEditor()
  const apiKey = editor.apiKey
  const [balance, setBalance] = useState<AccountBalance | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  const daily = useDailyUsage()
  const days = useLedger((state) => state.days)

  useEffect(
    () => () => {
      pending.current?.abort()
      pending.current = null
    },
    []
  )

  const refresh = async () => {
    if (!apiKey || pending.current) {
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const result = await fetchBalance(apiKey, controller.signal)
      if (pending.current === controller) {
        setBalance(result)
        setUpdatedAt(new Date().toLocaleTimeString())
      }
    } catch (reason) {
      if (pending.current !== controller) {
        return
      }
      const status = reason instanceof ApiError ? reason.status : undefined
      setError(
        controller.signal.aborted
          ? t('balanceTimeout')
          : status === 401
            ? t('balanceInvalidKey')
            : status === 429
              ? t('balanceRateLimited')
              : status
                ? t('balanceHttpFailed', { status })
                : t('balanceFailed')
      )
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) {
        pending.current = null
        setBusy(false)
      }
    }
  }

  const series = ledgerSeries(days, 30)
  const totals = ledgerTotals(series)
  const voice = totalVoiceUsage()
  const tokens = totals.input + totals.cacheRead + totals.cacheWrite + totals.output

  return (
    <div className={styles.wrap}>
      <section className={styles.card}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{t('balanceTitle')}</div>
            <div className={styles.hint}>
              {apiKey ? t('balanceDescription') : t('balanceNeedsKey')}
            </div>
          </div>
          <Button size="s" disabled={!apiKey || busy} onClick={() => void refresh()}>
            {busy ? t('balanceLoading') : t('balanceRefresh')}
          </Button>
        </div>
        {error ? <div className={styles.error}>{error}</div> : null}
        {updatedAt ? (
          <div className={styles.hint}>{t('balanceUpdated', { time: updatedAt })}</div>
        ) : null}
        {balance ? (
          <div className={styles.balanceList}>
            <div className={styles.balanceState}>
              {balance.is_available ? t('balanceAvailable') : t('balanceUnavailable')}
            </div>
            {balance.balance_infos.map((entry, index) => (
              <div key={`${entry.currency}-${index}`} className={styles.balanceRow}>
                <strong>
                  {t('balanceTotal', { currency: entry.currency, amount: entry.total_balance })}
                </strong>
                <span>
                  {t('balanceBreakdown', {
                    granted: entry.granted_balance,
                    toppedUp: entry.topped_up_balance,
                  })}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className={styles.card}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{t('accountUsageTitle')}</div>
            <div className={styles.hint}>{t('accountUsageHint')}</div>
          </div>
          <Button size="s" variant="outlined" onClick={() => setSettingsSection('stats')}>
            {t('accountOpenStats')}
          </Button>
        </div>
        <div className={styles.grid}>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('accountTodayTokens')}</span>
            <span className={styles.kpiValue}>{formatTokens(daily.totalTokens)}</span>
            <span className={styles.kpiHint}>
              {t('accountBilledTokens', { tokens: formatTokens(daily.billedTokens) })}
            </span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('accountTodayCost')}</span>
            <span className={styles.kpiValue}>{formatMoney(daily.cost)}</span>
            <span className={styles.kpiHint}>{t('accountTodayCostHint')}</span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('accountMonthTokens')}</span>
            <span className={styles.kpiValue}>{formatTokens(tokens)}</span>
            <span className={styles.kpiHint}>
              {t('accountMonthRequests', { count: totals.requests })}
            </span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('accountMonthCost')}</span>
            <span className={styles.kpiValue}>{formatMoney(totals.cost)}</span>
            <span className={styles.kpiHint}>{t('accountMonthCostHint')}</span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('statsKpiSearches')}</span>
            <span className={styles.kpiValue}>{totals.searches}</span>
            <span className={styles.kpiHint}>{t('accountSearchesHint')}</span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('statsExtrasPages')}</span>
            <span className={styles.kpiValue}>{totals.pages}</span>
            <span className={styles.kpiHint}>{t('accountPagesHint')}</span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('statsExtrasTtsChars')}</span>
            <span className={styles.kpiValue}>{formatTokens(voice.chars)}</span>
            <span className={styles.kpiHint}>{t('accountVoiceHint')}</span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('statsExtrasAsrSeconds')}</span>
            <span className={styles.kpiValue}>{formatTokens(voice.seconds)}</span>
            <span className={styles.kpiHint}>{t('accountVoiceHint')}</span>
          </div>
        </div>
        <div className={styles.note}>{t('accountExtraApiNote')}</div>
      </section>
    </div>
  )
}
