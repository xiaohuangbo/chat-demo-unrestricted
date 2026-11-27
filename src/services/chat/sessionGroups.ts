import { translate } from '../../i18n/index.js'
import { monthKey } from '../../utils/format.js'
import type { SessionSummary } from './types.js'

const DAY = 86_400_000

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

/**
 * 分组：置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 按月。
 * 置顶的会话先单独成组（组内仍按最近更新排序），其余按日期分组。
 */
export const groupSessions = (sessions: SessionSummary[], now: number, t = translate) => {
  const groups: { key: string; label: string; sessions: SessionSummary[] }[] = []
  const pinned = sessions.filter((session) => session.pinned)
  if (pinned.length) {
    groups.push({ key: 'pinned', label: t('sessionPinnedGroupLabel'), sessions: pinned })
  }
  for (const session of sessions.filter((item) => !item.pinned)) {
    const diff = Math.floor((now - startOfDay(session.updatedAt)) / DAY)
    const key =
      diff <= 0
        ? 'sessionHistoryTimelineLabelToday'
        : diff <= 1
          ? 'sessionHistoryTimelineLabelYesterday'
          : diff < 7
            ? 'sessionHistoryTimelineLabel7days'
            : diff < 30
              ? 'sessionHistoryTimelineLabel30days'
              : null
    const groupKey = key ?? monthKey(session.updatedAt) ?? ''
    const last = groups.at(-1)
    if (last?.key === groupKey) {
      last.sessions.push(session)
    } else {
      groups.push({ key: groupKey, label: key ? t(key) : groupKey, sessions: [session] })
    }
  }
  return groups
}
