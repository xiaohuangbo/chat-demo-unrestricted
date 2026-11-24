import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { IconGenuiOutline16 } from '../base/icons.js'
import { parseGenuiSpec, type GenuiBlock, type GenuiTone } from '../../services/agent/genui.js'
import styles from './GenuiCard.module.css'

const toneClass = (tone: GenuiTone | undefined) => {
  switch (tone) {
    case 'success':
      return styles.toneSuccess
    case 'warn':
      return styles.toneWarn
    case 'error':
      return styles.toneError
    case 'neutral':
      return styles.toneNeutral
    default:
      return styles.toneInfo
  }
}

/** 表格点表头排序；数据都是字符串，数字列按数值比较 */
const GenuiTable = ({ block }: { block: Extract<GenuiBlock, { type: 'table' }> }) => {
  const [sort, setSort] = useState<{ index: number; desc: boolean } | null>(null)
  const rows = useMemo(() => {
    if (!sort) {
      return block.rows
    }
    const numeric = block.rows.every((row) => {
      const value = row[sort.index] ?? ''
      return value.trim() !== '' && Number.isFinite(Number(value))
    })
    const sorted = [...block.rows].sort((left, right) => {
      const a = left[sort.index] ?? ''
      const b = right[sort.index] ?? ''
      if (numeric) {
        return Number(a) - Number(b)
      }
      return a.localeCompare(b)
    })
    return sort.desc ? sorted.reverse() : sorted
  }, [block.rows, sort])
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        {block.caption ? <caption className={styles.caption}>{block.caption}</caption> : null}
        <thead>
          <tr>
            {block.columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                aria-sort={
                  sort?.index === index ? (sort.desc ? 'descending' : 'ascending') : 'none'
                }
              >
                <button
                  type="button"
                  className={styles.sortButton}
                  onClick={() =>
                    setSort((current) =>
                      current?.index === index
                        ? { index, desc: !current.desc }
                        : { index, desc: false }
                    )
                  }
                >
                  {column}
                  <span className={styles.sortMark}>
                    {sort?.index === index ? (sort.desc ? '↓' : '↑') : '↕'}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {block.columns.map((column, cellIndex) => (
                <td key={`${column}-${cellIndex}`}>{row[cellIndex] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const GenuiChart = ({ block }: { block: Extract<GenuiBlock, { type: 'chart' }> }) => {
  const width = 320
  const height = 120
  const padding = 18
  const values = block.series.flatMap((series) => series.data)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const points = block.labels.length
  const x = (index: number) => padding + (index * (width - padding * 2)) / Math.max(1, points - 1)
  const y = (value: number) => height - padding - ((value - min) / span) * (height - padding * 2)
  const colors = ['var(--dsw-alias-brand-primary)', '#68B9FF', '#F5A623', '#7ED321']
  return (
    <div className={styles.chart}>
      {block.caption ? <div className={styles.caption}>{block.caption}</div> : null}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={block.caption ?? 'chart'}>
        {[0, 0.5, 1].map((ratio) => (
          <line
            key={ratio}
            x1={padding}
            x2={width - padding}
            y1={padding + ratio * (height - padding * 2)}
            y2={padding + ratio * (height - padding * 2)}
            className={styles.gridLine}
          />
        ))}
        {block.kind === 'bar'
          ? block.series.map((series, seriesIndex) =>
              series.data.map((value, index) => {
                const barWidth = (width - padding * 2) / Math.max(1, points) / block.series.length
                return (
                  <rect
                    key={`${seriesIndex}-${index}`}
                    x={x(index) - (barWidth * block.series.length) / 2 + seriesIndex * barWidth}
                    y={y(value)}
                    width={Math.max(1, barWidth - 2)}
                    height={height - padding - y(value)}
                    fill={colors[seriesIndex % colors.length]}
                    opacity={0.85}
                    rx={2}
                  />
                )
              })
            )
          : block.series.map((series, seriesIndex) => (
              <polyline
                key={seriesIndex}
                fill="none"
                stroke={colors[seriesIndex % colors.length]}
                strokeWidth={2}
                points={series.data.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
              />
            ))}
      </svg>
      <div className={styles.legend}>
        {block.series.map((series, index) => (
          <span key={series.name} className={styles.legendItem}>
            <span
              className={styles.legendDot}
              style={{ background: colors[index % colors.length] }}
            />
            {series.name}
          </span>
        ))}
      </div>
    </div>
  )
}

const renderBlock = (block: GenuiBlock, key: number): React.ReactNode => {
  switch (block.type) {
    case 'heading':
      return (
        <h4 key={key} className={styles.heading}>
          {block.text}
        </h4>
      )
    case 'text':
      return (
        <p key={key} className={styles.text}>
          {block.text}
        </p>
      )
    case 'divider':
      return <hr key={key} className={styles.divider} />
    case 'badge':
      return (
        <span key={key} className={clsx(styles.badge, toneClass(block.tone))}>
          {block.text}
        </span>
      )
    case 'callout':
      return (
        <div key={key} className={clsx(styles.callout, toneClass(block.tone))}>
          {block.title ? <div className={styles.calloutTitle}>{block.title}</div> : null}
          <div>{block.text}</div>
        </div>
      )
    case 'list':
      return (
        <ul key={key} className={styles.list}>
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )
    case 'keyValue':
      return (
        <dl key={key} className={styles.keyValue}>
          {block.items.map((item, index) => (
            <div key={index} className={styles.keyValueRow}>
              <dt>{item.key}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )
    case 'stat':
      return (
        <div key={key} className={styles.stat}>
          <div className={styles.statLabel}>{block.label}</div>
          <div className={styles.statValue}>
            {block.value}
            {block.delta ? <span className={styles.statDelta}>{block.delta}</span> : null}
          </div>
          {block.hint ? <div className={styles.statHint}>{block.hint}</div> : null}
        </div>
      )
    case 'progress':
      return (
        <div key={key} className={styles.progress}>
          <div className={styles.progressHead}>
            <span>{block.label}</span>
            <span>{Math.round(block.value * 100)}%</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${block.value * 100}%` }} />
          </div>
          {block.hint ? <div className={styles.statHint}>{block.hint}</div> : null}
        </div>
      )
    case 'code':
      return (
        <pre key={key} className={styles.code}>
          <code>{block.text}</code>
        </pre>
      )
    case 'table':
      return <GenuiTable key={key} block={block} />
    case 'chart':
      return <GenuiChart key={key} block={block} />
    case 'card':
      return (
        <section key={key} className={styles.card}>
          {block.title ? <div className={styles.cardTitle}>{block.title}</div> : null}
          {block.blocks.map((entry, index) => renderBlock(entry, index))}
        </section>
      )
    case 'grid':
      return (
        <div
          key={key}
          className={styles.grid}
          style={{ gridTemplateColumns: `repeat(${block.columns ?? 2}, minmax(0, 1fr))` }}
        >
          {block.items.map((entry, index) => (
            <div key={index} className={styles.gridItem}>
              {renderBlock(entry, index)}
            </div>
          ))}
        </div>
      )
  }
}

/** 回复里的 GenUI 界面：解析白名单 JSON 后用原生组件渲染，不执行 HTML */
export const GenuiCard = ({ text, title }: { text: string; title?: string }) => {
  const t = useTranslate()
  const parsed = useMemo(() => parseGenuiSpec(text), [text])
  if ('error' in parsed) {
    return <div className={styles.error}>{t('genuiRenderError', { message: parsed.error })}</div>
  }
  return (
    <div className={styles.genui}>
      <div className={styles.header}>
        <span className={styles.icon}>
          <IconGenuiOutline16 />
        </span>
        <span className={styles.title}>{title || parsed.spec.title || t('genuiUntitled')}</span>
      </div>
      <div className={styles.blocks}>
        {parsed.spec.blocks.map((block, index) => renderBlock(block, index))}
      </div>
    </div>
  )
}
