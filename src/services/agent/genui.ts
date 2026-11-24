/**
 * GenUI：模型用一段 JSON 描述界面，客户端用白名单组件原生渲染。
 * 语法参考 dsh-genui（https://github.com/omdsh-dev/dsh-genui）的声明式组件树，
 * 这里只保留浏览器里最常用的一小组块，所有内容都是纯文本，不执行任意 HTML。
 */

export type GenuiTone = 'info' | 'success' | 'warn' | 'error' | 'neutral'

export type GenuiBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'divider' }
  | { type: 'badge'; text: string; tone?: GenuiTone }
  | { type: 'callout'; tone?: GenuiTone; title?: string; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'keyValue'; items: { key: string; value: string }[] }
  | { type: 'stat'; label: string; value: string; delta?: string; hint?: string }
  | { type: 'progress'; label: string; value: number; hint?: string }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'table'; caption?: string; columns: string[]; rows: string[][] }
  | {
      type: 'chart'
      kind: 'line' | 'bar'
      caption?: string
      labels: string[]
      series: { name: string; data: number[] }[]
    }
  | { type: 'card'; title?: string; blocks: GenuiBlock[] }
  | { type: 'grid'; columns?: number; items: GenuiBlock[] }

export type GenuiSpec = { title?: string; blocks: GenuiBlock[] }

export const GENUI_MAX_BLOCKS = 80
const MAX_DEPTH = 3
const MAX_TEXT = 4000
const MAX_ROWS = 100
const MAX_COLUMNS = 12
const MAX_SERIES = 4
const MAX_POINTS = 60

const tones: GenuiTone[] = ['info', 'success', 'warn', 'error', 'neutral']

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asText = (value: unknown, limit = MAX_TEXT): string =>
  typeof value === 'string' ? value.slice(0, limit) : typeof value === 'number' ? String(value) : ''

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const readTone = (value: unknown): GenuiTone | undefined =>
  typeof value === 'string' && (tones as string[]).includes(value)
    ? (value as GenuiTone)
    : undefined

/** 解析并裁剪一个块；不认识的类型返回 null（调用方忽略），坏数据只丢这一块 */
const readBlock = (value: unknown, depth: number): GenuiBlock | null => {
  if (depth > MAX_DEPTH) {
    return null
  }
  const item = asRecord(value)
  if (!item) {
    return null
  }
  switch (item.type) {
    case 'heading':
      return asText(item.text) ? { type: 'heading', text: asText(item.text) } : null
    case 'text':
      return asText(item.text) ? { type: 'text', text: asText(item.text) } : null
    case 'divider':
      return { type: 'divider' }
    case 'badge': {
      const text = asText(item.text, 80)
      return text ? { type: 'badge', text, tone: readTone(item.tone) } : null
    }
    case 'callout': {
      const text = asText(item.text)
      if (!text) {
        return null
      }
      return {
        type: 'callout',
        text,
        tone: readTone(item.tone) ?? 'info',
        ...(asText(item.title, 120) ? { title: asText(item.title, 120) } : {}),
      }
    }
    case 'list': {
      const items = asList(item.items)
        .map((entry) => asText(entry, 600))
        .filter(Boolean)
        .slice(0, 30)
      return items.length > 0 ? { type: 'list', items } : null
    }
    case 'keyValue': {
      const items = asList(item.items)
        .map((entry) => {
          const row = asRecord(entry)
          return row ? { key: asText(row.key, 120), value: asText(row.value, 600) } : null
        })
        .filter((row): row is { key: string; value: string } => !!row && !!row.key)
        .slice(0, 30)
      return items.length > 0 ? { type: 'keyValue', items } : null
    }
    case 'stat': {
      const label = asText(item.label, 120)
      const value = asText(item.value, 80)
      if (!label || !value) {
        return null
      }
      return {
        type: 'stat',
        label,
        value,
        ...(asText(item.delta, 40) ? { delta: asText(item.delta, 40) } : {}),
        ...(asText(item.hint, 160) ? { hint: asText(item.hint, 160) } : {}),
      }
    }
    case 'progress': {
      const label = asText(item.label, 120)
      const value = asNumber(item.value)
      if (!label || value === null) {
        return null
      }
      return {
        type: 'progress',
        label,
        value: Math.min(1, Math.max(0, value > 1 ? value / 100 : value)),
        ...(asText(item.hint, 160) ? { hint: asText(item.hint, 160) } : {}),
      }
    }
    case 'code': {
      const text = asText(item.text, 20000)
      return text
        ? { type: 'code', text, ...(asText(item.lang, 20) ? { lang: asText(item.lang, 20) } : {}) }
        : null
    }
    case 'table': {
      const columns = asList(item.columns)
        .map((entry) => asText(entry, 80))
        .filter(Boolean)
        .slice(0, MAX_COLUMNS)
      if (columns.length === 0) {
        return null
      }
      const rows = asList(item.rows)
        .map((row) =>
          asList(row)
            .map((cell) => asText(cell, 400))
            .slice(0, columns.length)
        )
        .slice(0, MAX_ROWS)
      return {
        type: 'table',
        columns,
        rows,
        ...(asText(item.caption, 160) ? { caption: asText(item.caption, 160) } : {}),
      }
    }
    case 'chart': {
      const kind = item.kind === 'bar' ? 'bar' : item.kind === 'line' ? 'line' : null
      const labels = asList(item.labels)
        .map((entry) => asText(entry, 40))
        .slice(0, MAX_POINTS)
      const series = asList(item.series)
        .map((entry) => {
          const row = asRecord(entry)
          if (!row) {
            return null
          }
          const data = asList(row.data)
            .map((value) => asNumber(value))
            .filter((value): value is number => value !== null)
            .slice(0, MAX_POINTS)
          const name = asText(row.name, 60) || '数据'
          return data.length > 0 ? { name, data } : null
        })
        .filter((entry): entry is { name: string; data: number[] } => entry !== null)
        .slice(0, MAX_SERIES)
      if (!kind || labels.length === 0 || series.length === 0) {
        return null
      }
      return {
        type: 'chart',
        kind,
        labels,
        series,
        ...(asText(item.caption, 160) ? { caption: asText(item.caption, 160) } : {}),
      }
    }
    case 'card': {
      const blocks = asList(item.blocks).map((entry) => readBlock(entry, depth + 1))
      const clean = blocks.filter((entry): entry is GenuiBlock => entry !== null)
      return clean.length > 0
        ? {
            type: 'card',
            blocks: clean,
            ...(asText(item.title, 120) ? { title: asText(item.title, 120) } : {}),
          }
        : null
    }
    case 'grid': {
      const items = asList(item.items).map((entry) => readBlock(entry, depth + 1))
      const clean = items.filter((entry): entry is GenuiBlock => entry !== null)
      const columns = asNumber(item.columns)
      return clean.length > 0
        ? {
            type: 'grid',
            items: clean,
            columns: columns ? Math.min(3, Math.max(1, Math.round(columns))) : 2,
          }
        : null
    }
    default:
      return null
  }
}

export const parseGenuiSpec = (raw: string): { spec: GenuiSpec } | { error: string } => {
  const text = raw.trim()
  if (!text) {
    return { error: 'spec 不能为空' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: 'spec 不是合法 JSON，请检查引号、逗号与括号' }
  }
  const item = asRecord(value)
  if (!item) {
    return { error: 'spec 必须是对象，例如 {"title":"…","blocks":[…]}' }
  }
  const blocks = asList(item.blocks)
    .map((entry) => readBlock(entry, 0))
    .filter((entry): entry is GenuiBlock => entry !== null)
    .slice(0, GENUI_MAX_BLOCKS)
  if (blocks.length === 0) {
    return { error: 'spec.blocks 里没有可渲染的块，请检查 type 是否为支持的组件' }
  }
  return {
    spec: {
      blocks,
      ...(asText(item.title, 120) ? { title: asText(item.title, 120) } : {}),
    },
  }
}

/** 把模型给的 spec 规范化，产物里只保存白名单字段 */
export const normalizeGenuiSpec = (spec: GenuiSpec): string => JSON.stringify(spec)
