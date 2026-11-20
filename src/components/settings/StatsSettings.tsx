import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import { Switch } from '../base/Switch.js'
import { BarChart, Heatmap, RingChart, type BarColumn, type HeatCell } from '../stats/charts.js'
import {
  LEDGER_KEEP_DAYS,
  clearLedger,
  exportLedger,
  ledgerCsv,
  ledgerHourly,
  ledgerModels,
  ledgerSeries,
  ledgerSessions,
  ledgerTotals,
  useLedger,
  type DayUsage,
} from '../../services/chat/usageLedger.js'
import {
  clearContextUsage,
  contextUsageEntries,
  contextWindowFor,
  useContextUsage,
} from '../../services/chat/contextUsage.js'
import { effectiveContextTokens, pressurePercent } from '../../services/chat/contextPressure.js'
import {
  billingRates,
  formatMoney,
  formatTokens,
  modelPriceFor,
  totalVoiceUsage,
} from '../../services/chat/sessionStats.js'
import {
  CONTEXT_CATEGORIES,
  breakdownTotal,
  clearContextBreakdown,
  useContextBreakdown,
} from '../../services/chat/contextBreakdown.js'
import type { TranslationKey } from '../../i18n/index.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { closeSettings } from './settingsDialogState.js'
import { setServerSearchFree, useSettings } from '../../services/settings.js'
import { modelLabel } from '../../services/api/models.js'
import { isLocalModel } from '../../services/local/catalog.js'
import settingsStyles from './Settings.module.css'
import styles from './StatsSettings.module.css'

/**
 * 设置 → 统计。
 *
 * 上半部分是长期用量：范围切换、KPI、每日趋势柱状图、活跃热力图、输入构成环、按模型拆分。
 * 下半部分是上下文统计管理：当前窗口压力、每个会话最近一次请求的上下文体量，
 * 以及清空记录 / 导出统计等维护动作。
 *
 * 数据来源：usageLedger（跨天保留最近 400 天，只含聚合数字）与 contextUsage（按会话）。
 */

/** 范围选项：天数与对应的文案键 */
const RANGES = [
  { days: 1, label: 'statsRangeToday' },
  { days: 7, label: 'statsRange7' },
  { days: 30, label: 'statsRange30' },
] as const

const HEATMAP_DAYS = 56

/** 趋势图的指标切换 */
const METRICS = [
  { value: 'tokens', label: 'statsMetricTokens' },
  { value: 'cost', label: 'statsMetricCost' },
  { value: 'requests', label: 'statsMetricRequests' },
] as const

/** 热力图强度：按当天的 token 总量相对峰值分档，全 0 时全部落在 0 档 */
const heatLevel = (value: number, max: number): number => {
  if (value <= 0 || max <= 0) {
    return 0
  }
  const ratio = value / max
  if (ratio >= 0.75) {
    return 4
  }
  if (ratio >= 0.5) {
    return 3
  }
  if (ratio >= 0.25) {
    return 2
  }
  return 1
}

/** 日期轴标签：只显示「日」，范围短时加月份避免跨月看不出 */
const dayLabel = (day: DayUsage, withMonth: boolean): string => {
  const [, month, date] = day.date.split('-')
  return withMonth ? `${Number(month)}/${Number(date)}` : String(Number(date))
}

const tokenTotal = (day: DayUsage): number =>
  day.input + day.cacheRead + day.cacheWrite + day.output

const formatTime = (at: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at))

export const StatsSettings = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const model = useSettings((state) => state.model)
  const maxTokens = useSettings((state) => state.maxTokens)
  const serverSearchFree = useSettings((state) => state.serverSearchFree)
  const days = useLedger((state) => state.days)
  const [rangeDays, setRangeDays] = useState(7)
  // 趋势图可以切换看点：token / 费用 / 请求数
  const [metric, setMetric] = useState<'tokens' | 'cost' | 'requests'>('tokens')
  const usageById = useContextUsage((state) => state.byId)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const breakdownEntry = useContextBreakdown((state) =>
    activeId ? state.byId[activeId] : undefined
  )

  const series = useMemo(() => ledgerSeries(days, rangeDays), [days, rangeDays])
  const totals = useMemo(() => ledgerTotals(series), [series])
  const models = useMemo(() => ledgerModels(series), [series])
  const heatSeries = useMemo(
    () => (rangeDays === HEATMAP_DAYS ? series : ledgerSeries(days, HEATMAP_DAYS)),
    [days, rangeDays, series]
  )
  const hourly = useMemo(() => ledgerHourly(series), [series])
  const rankedSessions = useMemo(() => ledgerSessions(series), [series])
  // 语音用量按会话存在 localStorage，账本变化时顺带重算一次即可
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const voice = useMemo(() => totalVoiceUsage(), [days])

  const composition = useMemo(() => {
    const inputTotal = totals.input + totals.cacheRead + totals.cacheWrite
    const sum = inputTotal + totals.output
    const share = (value: number) => (sum > 0 ? (value / sum) * 100 : 0)
    return {
      sum,
      segments: [
        {
          key: 'uncached',
          label: t('statsCompositionUncached'),
          value: totals.input,
          share: share(totals.input),
        },
        {
          key: 'cacheRead',
          label: t('statsCompositionCacheRead'),
          value: totals.cacheRead,
          share: share(totals.cacheRead),
        },
        {
          key: 'cacheWrite',
          label: t('statsCompositionCacheWrite'),
          value: totals.cacheWrite,
          share: share(totals.cacheWrite),
        },
        {
          key: 'output',
          label: t('statsCompositionOutput'),
          value: totals.output,
          share: share(totals.output),
        },
      ].filter((segment) => segment.value > 0),
    }
  }, [totals, t])

  // 上下文分类：只展示当前会话最近一轮；没有记录时给出空状态
  const breakdown = breakdownEntry?.parts
  const breakdownSum = breakdown ? breakdownTotal(breakdown) : 0
  const breakdownRows = breakdown
    ? CONTEXT_CATEGORIES.map((key) => ({
        key,
        label: t(`contextCategory_${key}` as TranslationKey),
        tokens: breakdown[key],
        share: breakdownSum > 0 ? (breakdown[key] / breakdownSum) * 100 : 0,
      })).filter((row) => row.tokens > 0)
    : []
  const rates = billingRates()
  const price = modelPriceFor(model)

  const window = contextWindowFor(model)
  const entries = useMemo(() => contextUsageEntries(usageById), [usageById])
  const titleById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title])),
    [sessions]
  )
  const activeCompression = useChatStore((state) =>
    activeId ? state.sessionCache[activeId]?.compression : undefined
  )
  const activeUsage = activeId ? usageById[activeId] : undefined
  const activeTokens = effectiveContextTokens(
    activeUsage?.tokens ?? 0,
    activeUsage?.at ?? 0,
    activeCompression
  )
  const activePercent = pressurePercent(activeTokens, window)
  const trackedTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0)
  const largest = entries[0] ?? null

  const chartColumns: BarColumn[] = series.map((day) => ({
    key: day.date,
    label: dayLabel(day, rangeDays > 1),
    primary:
      metric === 'tokens'
        ? tokenTotal(day)
        : metric === 'cost'
          ? Number(day.cost.toFixed(6))
          : day.requests,
    secondary: metric === 'tokens' ? day.cost : undefined,
    title: t('statsTrendTooltip', {
      date: day.date,
      tokens: formatTokens(tokenTotal(day)),
      cost: formatMoney(day.cost),
      requests: day.requests,
    }),
  }))

  // 小时分布：只每隔 3 小时标一次刻度，避免 24 个标签挤在一起
  const hourColumns: BarColumn[] = hourly.map((requests, hour) => ({
    key: `hour-${hour}`,
    label: hour % 3 === 0 ? String(hour) : '',
    primary: requests,
    title: t('statsHourTooltip', { hour, requests }),
  }))
  // 找出请求最多的小时；全部为 0 时落在 0 点
  const busiestHour = hourly.reduce(
    (best, requests, hour) => (requests > (hourly[best] ?? 0) ? hour : best),
    0
  )

  const heatMax = Math.max(1, ...heatSeries.map(tokenTotal))
  const heatCells: HeatCell[] = heatSeries.map((day) => ({
    key: day.date,
    level: heatLevel(tokenTotal(day), heatMax),
    title: t('statsHeatmapTooltip', {
      date: day.date,
      tokens: formatTokens(tokenTotal(day)),
      requests: day.requests,
    }),
  }))

  const kpis: { key: TranslationKey; value: string }[] = [
    {
      key: 'statsKpiTokens',
      value: formatTokens(totals.input + totals.cacheRead + totals.cacheWrite + totals.output),
    },
    { key: 'statsKpiCost', value: formatMoney(totals.cost) },
    {
      key: 'statsKpiCache',
      value: totals.cacheRate === null ? '—' : `${(totals.cacheRate * 100).toFixed(1)}%`,
    },
    { key: 'statsKpiRequests', value: String(totals.requests) },
    { key: 'statsKpiActiveDays', value: String(totals.activeDays) },
    { key: 'statsKpiSearches', value: String(totals.searches) },
  ]

  return (
    <>
      <div className={settingsStyles.groupTitle}>{t('statsOverviewTitle')}</div>
      <section className={styles.card}>
        <div className={styles.rangeRow}>
          <div className={styles.rangeTabs} role="tablist" aria-label={t('statsRangeLabel')}>
            {RANGES.map((item) => (
              <button
                key={item.days}
                type="button"
                role="tab"
                aria-selected={rangeDays === item.days}
                className={clsx(styles.rangeTab, rangeDays === item.days && styles.rangeTabActive)}
                onClick={() => setRangeDays(item.days)}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
          <span className={styles.rangeHint}>{t('statsRangeHint')}</span>
        </div>

        <div className={styles.kpis}>
          {kpis.map((item) => (
            <div key={item.key} className={styles.kpi}>
              <span className={styles.kpiLabel}>{t(item.key)}</span>
              <span className={styles.kpiValue}>{item.value}</span>
            </div>
          ))}
        </div>

        <div className={styles.blockHead}>
          <span className={styles.blockTitle}>{t('statsTrendTitle')}</span>
          <div className={styles.metricTabs} role="tablist" aria-label={t('statsMetricLabel')}>
            {METRICS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={metric === item.value}
                className={clsx(styles.metricTab, metric === item.value && styles.metricTabActive)}
                onClick={() => setMetric(item.value)}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
        </div>
        {totals.requests > 0 ? (
          <BarChart columns={chartColumns} ariaLabel={t('statsTrendTitle')} />
        ) : (
          <div className={styles.empty}>{t('statsNoData')}</div>
        )}
        <div className={styles.note}>
          {metric === 'tokens' ? t('statsTrendHint') : t('statsTrendHintSingle')}
        </div>
      </section>

      <div className={settingsStyles.groupTitle}>{t('statsHeatmapTitle')}</div>
      <section className={styles.card}>
        <Heatmap cells={heatCells} ariaLabel={t('statsHeatmapTitle')} />
        <div className={styles.heatLegend}>
          <span>{t('statsHeatmapLess')}</span>
          <span className={styles.heatScale} aria-hidden>
            {[0, 1, 2, 3, 4].map((level) => (
              <span key={level} className={styles.heatSwatch} data-level={level} />
            ))}
          </span>
          <span>{t('statsHeatmapMore')}</span>
        </div>
        <div className={styles.note}>{t('statsHeatmapHint')}</div>
      </section>

      <div className={settingsStyles.groupTitle}>{t('statsHourlyTitle')}</div>
      <section className={styles.card}>
        {totals.requests > 0 ? (
          <>
            <BarChart columns={hourColumns} ariaLabel={t('statsHourlyTitle')} height={104} />
            <div className={styles.note}>
              {t('statsHourlyHint', {
                hour: busiestHour,
                requests: hourly[busiestHour] ?? 0,
              })}
            </div>
          </>
        ) : (
          <div className={styles.empty}>{t('statsNoData')}</div>
        )}
      </section>

      <div className={settingsStyles.groupTitle}>{t('statsCompositionTitle')}</div>
      <section className={styles.card}>
        {composition.sum > 0 ? (
          <div className={styles.ringRow}>
            <RingChart
              segments={composition.segments.map((segment) => ({
                key: segment.key,
                label: segment.label,
                value: segment.value,
              }))}
              centerLabel={t('statsUnitTokens')}
              centerValue={formatTokens(composition.sum)}
              ariaLabel={t('statsCompositionTitle')}
            />
            <ul className={styles.ringLegend}>
              {composition.segments.map((segment, index) => (
                <li key={segment.key} className={styles.ringLegendItem}>
                  <span className={styles.swatch} data-index={(index % 5) + 1} aria-hidden />
                  <span className={styles.ringLegendLabel}>{segment.label}</span>
                  <span className={styles.ringLegendValue}>
                    {formatTokens(segment.value)} · {segment.share.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className={styles.empty}>{t('statsNoData')}</div>
        )}
        <div className={styles.note}>{t('statsCompositionHint')}</div>
      </section>

      <div className={settingsStyles.groupTitle}>{t('statsModelsTitle')}</div>
      <section className={styles.card}>
        {models.length > 0 ? (
          <div className={styles.modelList}>
            {models.map((item) => (
              <div key={item.model} className={styles.modelRow}>
                <span className={styles.modelName}>{modelLabel(item.model)}</span>
                <span className={styles.modelMeta}>
                  {t('statsModelMeta', {
                    requests: item.usage.requests,
                    tokens: formatTokens(
                      item.usage.input +
                        item.usage.cacheRead +
                        item.usage.cacheWrite +
                        item.usage.output
                    ),
                  })}
                </span>
                <span className={styles.modelCost}>
                  {isLocalModel(item.model)
                    ? t('statsModelLocalFree')
                    : formatMoney(item.usage.cost)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.empty}>{t('statsNoData')}</div>
        )}
        <div className={styles.note}>{t('statsModelsHint')}</div>
      </section>

      <div className={settingsStyles.groupTitle}>{t('statsSessionRankTitle')}</div>
      <section className={styles.card}>
        {rankedSessions.length > 0 ? (
          <div className={styles.table} role="table" aria-label={t('statsSessionRankTitle')}>
            <div className={styles.tableHead} role="row">
              <span role="columnheader">{t('statsSessionRankColumnSession')}</span>
              <span role="columnheader">{t('statsSessionRankColumnTokens')}</span>
              <span role="columnheader">{t('statsSessionRankColumnCost')}</span>
              <span role="columnheader">{t('statsSessionRankColumnRequests')}</span>
              <span role="columnheader">{t('statsSessionRankColumnActions')}</span>
            </div>
            {rankedSessions.slice(0, 6).map((item) => {
              const known = titleById.has(item.id)
              return (
                <div key={item.id} className={styles.tableRow} role="row">
                  <span className={styles.sessionName} role="cell" title={item.id}>
                    {titleById.get(item.id) ?? t('statsContextUnknownTitle')}
                  </span>
                  <span role="cell" className={styles.numeric}>
                    {formatTokens(item.tokens)}
                  </span>
                  <span role="cell" className={styles.numeric}>
                    {formatMoney(item.cost)}
                  </span>
                  <span role="cell" className={styles.numeric}>
                    {item.requests}
                  </span>
                  <span role="cell" className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.linkButton}
                      disabled={!known}
                      title={known ? undefined : t('statsSessionRankGone')}
                      onClick={() => {
                        closeSettings()
                        selectSession(item.id)
                      }}
                    >
                      {t('statsSessionRankOpen')}
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className={styles.empty}>{t('statsNoData')}</div>
        )}
        <div className={styles.note}>{t('statsSessionRankHint')}</div>
      </section>

      <div className={settingsStyles.groupTitle}>{t('statsExtrasTitle')}</div>
      <section className={styles.card}>
        <div className={styles.kpis}>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('statsKpiSearches')}</span>
            <span className={styles.kpiValue}>{totals.searches}</span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('statsExtrasPages')}</span>
            <span className={styles.kpiValue}>{totals.pages}</span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('statsExtrasTtsChars')}</span>
            <span className={styles.kpiValue}>{formatTokens(voice.chars)}</span>
          </div>
          <div className={styles.kpi}>
            <span className={styles.kpiLabel}>{t('statsExtrasAsrSeconds')}</span>
            <span className={styles.kpiValue}>{Math.round(voice.seconds)}</span>
          </div>
        </div>
        <div className={styles.note}>{t('statsExtrasHint')}</div>
      </section>

      <div className={settingsStyles.groupTitle}>{t('contextBreakdownTitle')}</div>
      <section className={styles.card}>
        {breakdownRows.length > 0 ? (
          <div className={styles.ringRow}>
            <RingChart
              segments={breakdownRows.map((row) => ({
                key: row.key,
                label: row.label,
                value: row.tokens,
              }))}
              centerLabel={t('statsUnitTokens')}
              centerValue={formatTokens(breakdownSum)}
              ariaLabel={t('contextBreakdownTitle')}
            />
            <ul className={styles.ringLegend}>
              {breakdownRows.map((row, index) => (
                <li key={row.key} className={styles.ringLegendItem}>
                  <span className={styles.swatch} data-index={(index % 5) + 1} aria-hidden />
                  <span className={styles.ringLegendLabel}>{row.label}</span>
                  <span className={styles.ringLegendValue}>
                    {formatTokens(row.tokens)} · {row.share.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className={styles.empty}>{t('contextBreakdownEmpty')}</div>
        )}
        <div className={styles.note}>{t('contextBreakdownHint')}</div>
      </section>

      <div className={settingsStyles.groupTitle}>{t('billingRatesTitle')}</div>
      <section className={styles.card}>
        <div className={styles.billingSwitch}>
          <div className={styles.billingSwitchText}>
            <span className={styles.billingSwitchLabel}>{t('billingSearchFreeLabel')}</span>
            <span className={styles.billingSwitchDesc}>{t('billingSearchFreeDesc')}</span>
          </div>
          <Switch
            checked={serverSearchFree}
            onChange={setServerSearchFree}
            label={t('billingSearchFreeLabel')}
          />
        </div>
        <div className={styles.rateList}>
          <div className={styles.rateRow}>
            <span className={styles.rateName}>
              {t('billingRateModel', { model: modelLabel(model) })}
            </span>
            <span className={styles.rateValue}>
              {isLocalModel(model)
                ? t('billingRateLocalNote')
                : t('billingRateTokens', {
                    miss: price.cacheMiss,
                    hit: price.cacheHit,
                    output: price.output,
                  })}
            </span>
          </div>
          <div className={styles.rateRow}>
            <span className={styles.rateName}>{t('statsKpiSearches')}</span>
            <span className={styles.rateValue}>
              {serverSearchFree
                ? t('billingSearchFreeValue')
                : t('billingRatePerCall', { price: rates.searchPerCall })}
            </span>
          </div>
          <div className={styles.rateRow}>
            <span className={styles.rateName}>{t('statsExtrasPages')}</span>
            <span className={styles.rateValue}>
              {t('billingRatePerPage', { price: rates.parsePerPage })}
            </span>
          </div>
          <div className={styles.rateRow}>
            <span className={styles.rateName}>{t('statsExtrasTtsChars')}</span>
            <span className={styles.rateValue}>
              {t('billingRatePerChar', { price: rates.ttsPerChar })}
            </span>
          </div>
          <div className={styles.rateRow}>
            <span className={styles.rateName}>{t('statsExtrasAsrSeconds')}</span>
            <span className={styles.rateValue}>
              {t('billingRatePerSecond', { price: rates.asrPerSecond })}
            </span>
          </div>
        </div>
        <div className={styles.note}>{t('billingRatesHint')}</div>
      </section>

      <div className={settingsStyles.groupTitle}>{t('statsContextTitle')}</div>
      <section className={styles.card}>
        <div className={styles.contextHead}>
          <div className={styles.contextKpis}>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>{t('statsContextActive')}</span>
              <span className={styles.kpiValue}>
                {formatTokens(activeTokens)} / {formatTokens(window)}
              </span>
            </div>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>{t('statsContextPressure')}</span>
              <span className={styles.kpiValue}>{Math.round(activePercent)}%</span>
            </div>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>{t('statsContextTracked')}</span>
              <span className={styles.kpiValue}>{entries.length}</span>
            </div>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>{t('statsContextTrackedTokens')}</span>
              <span className={styles.kpiValue}>{formatTokens(trackedTokens)}</span>
            </div>
          </div>
        </div>
        <div className={styles.pressureBar} data-warn={activePercent >= 80 || undefined}>
          <span style={{ width: `${Math.min(100, Math.max(0, activePercent))}%` }} />
        </div>
        <div className={styles.note}>
          {t('statsContextWindowHint', {
            model: modelLabel(model),
            window: formatTokens(window),
            output: formatTokens(maxTokens ?? 8192),
          })}
        </div>

        {entries.length > 0 ? (
          <div className={styles.table} role="table" aria-label={t('statsContextTitle')}>
            <div className={styles.tableHead} role="row">
              <span role="columnheader">{t('statsContextColumnSession')}</span>
              <span role="columnheader">{t('statsContextColumnTokens')}</span>
              <span role="columnheader">{t('statsContextColumnShare')}</span>
              <span role="columnheader">{t('statsContextColumnUpdated')}</span>
              <span role="columnheader">{t('statsContextColumnActions')}</span>
            </div>
            {entries.slice(0, 8).map((entry) => {
              const percent = pressurePercent(entry.tokens, window)
              return (
                <div key={entry.id} className={styles.tableRow} role="row">
                  <span className={styles.sessionName} role="cell" title={entry.id}>
                    {titleById.get(entry.id) ?? t('statsContextUnknownTitle')}
                  </span>
                  <span role="cell" className={styles.numeric}>
                    {formatTokens(entry.tokens)}
                  </span>
                  <span
                    role="cell"
                    className={styles.numeric}
                    data-warn={percent >= 80 || undefined}
                  >
                    {Math.round(percent)}%
                  </span>
                  <span role="cell" className={styles.muted}>
                    {formatTime(entry.at, locale)}
                  </span>
                  <span role="cell" className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => clearContextUsage(entry.id)}
                    >
                      {t('statsContextClearOne')}
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className={styles.empty}>{t('statsContextEmpty')}</div>
        )}
        {largest && entries.length > 8 ? (
          <div className={styles.note}>
            {t('statsContextLargest', { tokens: formatTokens(largest.tokens) })}
          </div>
        ) : null}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.textButton}
            disabled={entries.length === 0}
            onClick={() => {
              clearContextUsage()
              clearContextBreakdown()
              showToast({ key: 'statsContextCleared' })
            }}
          >
            {t('statsContextClearAll')}
          </button>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              const snapshot = exportLedger()
              const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
                type: 'application/json',
              })
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = `chat-demo-stats-${new Date().toISOString().slice(0, 10)}.json`
              link.click()
              setTimeout(() => URL.revokeObjectURL(url), 10_000)
              showToast({ key: 'statsExported' })
            }}
          >
            {t('statsExport')}
          </button>
          <button
            type="button"
            className={styles.textButton}
            disabled={totals.requests === 0}
            onClick={() => {
              const blob = new Blob([ledgerCsv(series)], { type: 'text/csv;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = `chat-demo-usage-${new Date().toISOString().slice(0, 10)}.csv`
              link.click()
              setTimeout(() => URL.revokeObjectURL(url), 10_000)
              showToast({ key: 'statsExported' })
            }}
          >
            {t('statsExportCsv')}
          </button>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              clearLedger()
              showToast({ key: 'statsLedgerCleared' })
            }}
          >
            {t('statsClearLedger')}
          </button>
        </div>
        <div className={styles.note}>{t('statsKeepHint', { days: LEDGER_KEEP_DAYS })}</div>
      </section>
    </>
  )
}
