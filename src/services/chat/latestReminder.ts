import { getRegionName, provinces, specialPlaceName, type UserLocation } from '../location.js'
import type { Locale } from '../settings.js'
import { formatDate } from '../../utils/format.js'
import { translate } from '../../i18n/index.js'

const locationName = (location: UserLocation | null, locale: Locale): string => {
  if (!location) {
    return ''
  }
  if (location.custom) {
    return location.custom
  }
  if (location.place) {
    return specialPlaceName(location.place, locale)
  }
  if (location.region === 'CN' && locale === 'zh-CN') {
    const province = provinces.find((item) => item.code === location.province)
    const city = province?.cities.find((item) => item.code === location.city)
    return city?.name ?? province?.name ?? getRegionName('CN', locale)
  }
  return getRegionName(location.region, locale)
}

/**
 * 单个字段必须不含逗号与换行。
 *
 * 服务端把整串 latest_reminder 按逗号严格解析成五个字段：
 * `<date>,<weekday>,<location>,<platform>,<language>`，多一个逗号或换行都会让后面的文字
 * 被当成别的字段，直接回 400（unknown platform / unknown language）。自定义位置里也可能带逗号，
 * 所以这里统一把字段内的逗号折成空格。
 */
export const reminderField = (value: string | null | undefined): string =>
  (value ?? '')
    .replace(/[,\uFF0C\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** 模型约定的五项信息；日期与星期使用浏览器本地时区，避免 UTC 日期跨日。 */
export const createLatestReminder = (
  { locale, location }: { locale: Locale; location: UserLocation | null },
  now = new Date()
): string => {
  return [
    formatDate(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationName(location, locale),
    'Web',
    translate('latestReminderLanguage'),
  ]
    .map(reminderField)
    .join(',')
}
