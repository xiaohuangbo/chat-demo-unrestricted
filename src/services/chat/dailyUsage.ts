import { create } from 'zustand'
import type { MessageUsage } from '../api/types.js'
import { isLocalModel } from '../local/catalog.js'
import { usageCost } from './sessionStats.js'
import { useSettings } from '../settings.js'
import { showToast } from '../../components/base/toastState.js'

/**
 * 每日 Token / 费用统计与提醒。
 * 数据按本地日期归档，跨天自动归零；达到上限当天只提醒一次。
 */

const STORAGE_KEY = 'chat-demo:daily-usage'

export type DailyUsage = {
  date: string
  inputTokens: number
  outputTokens: number
  /** 今日全部 token（含本地模型，仅用于展示） */
  totalTokens: number
  /** 其中会计费的 token：本地模型（WebLLM / MLC-LLM）不计入，额度提醒只看这个值 */
  billedTokens: number
  cost: number
  alertedTokenDate: string | null
  alertedCostDate: string | null
}

type DailyUsageState = DailyUsage

const todayKey = (date = new Date()): string => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const empty = (date = todayKey()): DailyUsage => ({
  date,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  billedTokens: 0,
  cost: 0,
  alertedTokenDate: null,
  alertedCostDate: null,
})

const read = (): DailyUsage => {
  const today = todayKey()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return empty(today)
    }
    const parsed = JSON.parse(raw) as Partial<DailyUsage>
    if (parsed.date !== today) {
      return empty(today)
    }
    const number = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    return {
      date: today,
      inputTokens: number(parsed.inputTokens),
      outputTokens: number(parsed.outputTokens),
      totalTokens: number(parsed.totalTokens),
      // 旧版本没有 billedTokens：当时全部都是云端模型，按 totalTokens 迁移
      billedTokens:
        parsed.billedTokens === undefined
          ? number(parsed.totalTokens)
          : number(parsed.billedTokens),
      cost: number(parsed.cost),
      alertedTokenDate:
        typeof parsed.alertedTokenDate === 'string' ? parsed.alertedTokenDate : null,
      alertedCostDate: typeof parsed.alertedCostDate === 'string' ? parsed.alertedCostDate : null,
    }
  } catch {
    return empty(today)
  }
}

const write = (stats: DailyUsage) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats))
  } catch {
    // 隐私模式下写不进去也不影响本次显示
  }
}

export const useDailyUsage = create<DailyUsageState>(() => read())

/** 跨天检查；打开设置或统计弹窗时调用 */
export const syncDailyUsageDate = () => {
  const today = todayKey()
  if (useDailyUsage.getState().date !== today) {
    const fresh = empty(today)
    write(fresh)
    useDailyUsage.setState(fresh)
  }
}

/**
 * 记录一次请求的用量：token 总量按 input + cache_read + cache_creation + output，
 * 费用按该条回复的模型与当前时段计算。
 */
export const noteDailyUsage = (model: string, usage: MessageUsage, at = new Date()) => {
  const today = todayKey()
  const prev = useDailyUsage.getState()
  const base = prev.date === today ? prev : empty(today)
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  const output = usage.output_tokens ?? 0
  if (input + output <= 0) {
    return
  }
  const cost = usageCost(model, usage, at)
  // 本地模型的 token 不产生费用，也不占用「每日 token 额度」
  const billed = isLocalModel(model) ? 0 : input + output
  const { dailyLimitEnabled, dailyTokenLimit, dailyCostLimit } = useSettings.getState()
  const next: DailyUsage = {
    date: today,
    inputTokens: base.inputTokens + input,
    outputTokens: base.outputTokens + output,
    totalTokens: base.totalTokens + input + output,
    billedTokens: base.billedTokens + billed,
    cost: base.cost + cost,
    alertedTokenDate: base.alertedTokenDate,
    alertedCostDate: base.alertedCostDate,
  }
  if (dailyLimitEnabled && dailyTokenLimit > 0 && next.billedTokens >= dailyTokenLimit) {
    if (next.alertedTokenDate !== today) {
      next.alertedTokenDate = today
      showToast({
        key: 'dailyTokenLimitToast',
        params: {
          used: next.billedTokens.toLocaleString(),
          limit: dailyTokenLimit.toLocaleString(),
        },
      })
    }
  }
  if (dailyLimitEnabled && dailyCostLimit > 0 && next.cost >= dailyCostLimit) {
    if (next.alertedCostDate !== today) {
      next.alertedCostDate = today
      showToast({
        key: 'dailyCostLimitToast',
        params: {
          used: `¥${next.cost.toFixed(4)}`,
          limit: `¥${dailyCostLimit.toFixed(2)}`,
        },
      })
    }
  }
  write(next)
  useDailyUsage.setState(next)
}

export const resetDailyUsage = () => {
  const fresh = empty(todayKey())
  write(fresh)
  useDailyUsage.setState(fresh)
}
