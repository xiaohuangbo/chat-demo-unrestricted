import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { closeDocs } from '../../services/docs/docsStore.js'
import { docsFor, type DocsBlock, type DocsDoc } from './docsContent.js'
import { Button } from '../base/Button.js'
import styles from './DocsView.module.css'

/** 行内链接：`[文字](#小节)` 走页内跳转，`[文字](https://…)` 新窗口打开，统一蓝色 */
const renderInline = (text: string, jumpTo: (id: string) => void): ReactNode[] =>
  text.split(/(\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (!match) {
      return part
    }
    const [, label, href] = match
    if (href.startsWith('#')) {
      return (
        <a
          key={index}
          className={styles.link}
          href={href}
          onClick={(event) => {
            event.preventDefault()
            jumpTo(href.slice(1))
          }}
        >
          {label}
        </a>
      )
    }
    return (
      <a key={index} className={styles.link} href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    )
  })

const renderBlock = (block: DocsBlock, jumpTo: (id: string) => void) => {
  switch (block.type) {
    case 'p':
      return <p className={styles.paragraph}>{renderInline(block.text, jumpTo)}</p>
    case 'ul':
      return (
        <ul className={styles.list}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item, jumpTo)}</li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {block.head.map((cell) => (
                  <th key={cell}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell, jumpTo)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'note':
      return <div className={styles.note}>{renderInline(block.text, jumpTo)}</div>
    case 'code':
      return (
        <pre className={styles.code}>
          <code>{block.text}</code>
        </pre>
      )
  }
}

/**
 * 主界面「文档」：左侧目录 + 右侧正文，正文里的 `#小节` 链接直接滚动到对应段落。
 * 与实验台一样占满聊天区，关闭后回到原来的会话。
 */
export const DocsView = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const doc: DocsDoc = docsFor(locale)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(doc.sections[0]?.id ?? '')
  const [mobileTocOpen, setMobileTocOpen] = useState(false)
  /** 手机上滚过首屏后显示「回到目录」按钮 */
  const [showToTop, setShowToTop] = useState(false)

  const jumpTo = (id: string) => {
    const container = scrollRef.current
    const target = document.getElementById(`docs-${id}`)
    if (!container || !target) {
      return
    }
    const offset =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop
    container.scrollTo({ top: offset - 12, behavior: 'smooth' })
    setActive(id)
    setMobileTocOpen(false)
  }

  useEffect(() => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    const onScroll = () => {
      let current = doc.sections[0]?.id ?? ''
      const containerTop = container.getBoundingClientRect().top
      for (const section of doc.sections) {
        const element = document.getElementById(`docs-${section.id}`)
        if (element && element.getBoundingClientRect().top - containerTop <= 96) {
          current = section.id
        }
      }
      setActive(current)
      setShowToTop(container.scrollTop > 320)
    }
    onScroll()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [doc])

  return (
    <div className={styles.docs}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <div className={styles.title}>{t('docsTitle')}</div>
          <div className={styles.subtitle}>{doc.subtitle}</div>
        </div>
        <Button variant="outlined" size="s" onClick={closeDocs}>
          {t('docsBack')}
        </Button>
      </header>

      <details
        className={styles.mobileToc}
        open={mobileTocOpen}
        onToggle={(event) => setMobileTocOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary className={styles.mobileTocSummary}>{t('docsToc')}</summary>
        <nav className={styles.mobileTocList}>
          {doc.sections.map((section, index) => (
            <a
              key={section.id}
              className={clsx(styles.tocItem, section.id === active && styles.tocItemActive)}
              href={`#docs-${section.id}`}
              onClick={(event) => {
                event.preventDefault()
                jumpTo(section.id)
              }}
            >
              <span className={styles.tocIndex}>{index + 1}</span>
              {section.title}
            </a>
          ))}
        </nav>
      </details>

      <div className={styles.body}>
        <nav className={styles.toc}>
          <div className={styles.tocTitle}>{t('docsToc')}</div>
          {doc.sections.map((section, index) => (
            <a
              key={section.id}
              className={clsx(styles.tocItem, section.id === active && styles.tocItemActive)}
              href={`#docs-${section.id}`}
              onClick={(event) => {
                event.preventDefault()
                jumpTo(section.id)
              }}
            >
              <span className={styles.tocIndex}>{index + 1}</span>
              {section.title}
            </a>
          ))}
        </nav>

        <div ref={scrollRef} className={styles.article}>
          <div className={styles.hero}>
            <h1 className={styles.heroTitle}>{doc.title}</h1>
            <p className={styles.heroIntro}>{renderInline(doc.intro, jumpTo)}</p>
          </div>

          {doc.sections.map((section, index) => (
            <section key={section.id} id={`docs-${section.id}`} className={styles.section}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionIndex}>{index + 1}</span>
                {section.title}
                <a
                  className={styles.anchor}
                  href={`#docs-${section.id}`}
                  aria-label={section.title}
                  onClick={(event) => {
                    event.preventDefault()
                    jumpTo(section.id)
                  }}
                >
                  #
                </a>
              </h2>
              {section.blocks.map((block, blockIndex) => (
                <div key={blockIndex} className={styles.block}>
                  {renderBlock(block, jumpTo)}
                </div>
              ))}
            </section>
          ))}

          <div className={styles.footer}>{t('docsFooter')}</div>
        </div>
      </div>

      {showToTop ? (
        <button
          type="button"
          className={styles.toTop}
          onClick={() => {
            scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
            setMobileTocOpen(true)
          }}
        >
          {t('docsBackToTop')}
        </button>
      ) : null}
    </div>
  )
}
