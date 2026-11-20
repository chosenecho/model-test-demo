import { useId, useLayoutEffect, useRef } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Source } from '../../services/chat/view.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import styles from './SearchPanel.module.css'

const SearchResults = ({ entry, sources }: { entry: string; sources: Source[] }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const mobileStagger = Math.min(45, 400 / Math.max(1, sources.length - 1))

  useLayoutEffect(() => {
    const panel = dialog.current
    if (!panel) {
      return
    }
    if (isMobile) {
      panel.showModal()
    } else {
      panel.show()
    }
    return () => panel.close()
  }, [isMobile])

  return (
    <dialog
      ref={dialog}
      className={styles.panel}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        closeSearchPanel()
      }}
      onKeyDown={(event) => {
        if (!isMobile && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          closeSearchPanel()
        }
      }}
    >
      <div className={styles.surface}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {t('searchResult')}
          </h2>
          <IconButton
            icon={<IconCloseOutline16 />}
            size={isMobile ? 'xl' : 'xs'}
            aria-label={t('close')}
            onClick={closeSearchPanel}
          />
        </div>
        <div key={entry} className={styles.content}>
          {sources.map((source, index) => (
            <div
              key={source.url}
              className={styles.reveal}
              style={isMobile ? { animationDelay: `${120 + index * mobileStagger}ms` } : undefined}
            >
              <SourceCard source={source} className={styles.item} />
            </div>
          ))}
        </div>
      </div>
    </dialog>
  )
}

/** 右侧「搜索结果」面板 */
export const SearchPanel = () => {
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  return entry === null ? null : <SearchResults entry={entry} sources={sources} />
}
