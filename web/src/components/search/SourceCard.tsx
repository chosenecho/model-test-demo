import clsx from 'clsx'
import type { Source } from '../../services/chat/view.js'
import { SiteLogo } from './SiteLogo.js'
import styles from './SourceCard.module.css'

/** 使用来源给出的日历日期，省略无明确日期或无效的值。 */
const getPublishedDate = (value: string | null) => {
  const text = value?.trim() ?? ''
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/i.test(text)) {
    return null
  }
  const day = text.slice(0, 10)
  const date = new Date(day)
  return Number.isFinite(Date.parse(text)) && date.toISOString().startsWith(day) ? day : null
}

/**
 * 搜索结果卡片：站点图标与名称、日期、标题、摘要。
 * 元数据缺失时省略摘要，图标使用链接图标兜底。
 */
export const SourceCard = ({ source, className }: { source: Source; className?: string }) => {
  const date = getPublishedDate(source.publishedAt)
  return (
    <a
      className={clsx(styles.anchor, className)}
      href={source.url}
      target="_blank"
      rel="noreferrer"
    >
      <div className={styles.card}>
        <div className={styles.meta}>
          <SiteLogo url={source.siteIcon} className={styles.siteIcon} />
          {source.siteName ? <span className={styles.siteName}>{source.siteName}</span> : null}
          {source.siteName && date ? <span className={styles.divider} /> : null}
          {date ? (
            <time className={styles.date} dateTime={date}>
              {date.replaceAll('-', '/')}
            </time>
          ) : null}
        </div>
        <div className={styles.title}>{source.title}</div>
        {source.snippet ? <div className={styles.snippet}>{source.snippet}</div> : null}
      </div>
    </a>
  )
}
