import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  searchSessions,
  type SearchMatch,
  type SessionSearchResult,
} from '../../services/chat/sessionSearch.js'
import {
  initChat,
  loadSessionForSearch,
  selectSession,
  useChatStore,
} from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionSearch.module.css'

type SearchResponse = Awaited<ReturnType<typeof searchSessions>>

const Highlight = ({ match }: { match: SearchMatch }) => (
  <>
    {match.before}
    <mark className={styles.highlight}>{match.keyword}</mark>
    {match.after}
  </>
)

export const SessionSearch = ({
  dialogRef,
  open,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement>
  open: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const importing = useChatStore((state) => state.importingHistory)
  const selection = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const pointerStartedOutside = useRef(false)
  const [query, setQuery] = useState('')
  const [retry, setRetry] = useState(0)
  const [response, setResponse] = useState<
    | (SearchResponse & {
        keyword: string
        sessions: typeof sessions
        untitled: string
        retry: number
      })
    | null
  >(null)
  const keyword = query.trim().replace(/\s+/g, ' ')
  const untitled = t('untitledChat')

  useEffect(() => {
    if (!open || !keyword || !ready || importing) {
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      const result = await searchSessions(sessions, keyword, untitled, controller.signal)
      const state = useChatStore.getState()
      if (
        !controller.signal.aborted &&
        dialogRef.current?.open &&
        !dialogRef.current.hasAttribute('data-closing') &&
        !state.importingHistory &&
        state.sessions === sessions
      ) {
        setResponse({ ...result, keyword, sessions, untitled, retry })
      }
    }, 120)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [dialogRef, importing, keyword, open, ready, retry, sessions, untitled])

  const current =
    response?.keyword === keyword &&
    response.sessions === sessions &&
    response.untitled === untitled &&
    response.retry === retry
      ? response
      : null
  const matches = !ready || importing ? [] : (current?.results ?? [])
  const loading = ready && !importing && Boolean(keyword) && current === null
  const failed = !importing && (initError || current?.failed)
  const status =
    !ready || importing
      ? t(initError ? 'sessionListLoadFailed' : 'sessionLoading')
      : loading
        ? t('searchSessionsLoading')
        : failed
          ? t('searchSessionsReadFailed')
          : matches.length === 0
            ? t('searchSessionsEmpty')
            : ''

  const closeDialog = async () => {
    const dialog = dialogRef.current
    if (!dialog?.open || dialog.hasAttribute('data-closing')) {
      return false
    }

    selection.current++
    const panelStyle = getComputedStyle(dialog)
    dialog.style.setProperty('--search-exit-opacity', panelStyle.opacity)
    dialog.style.setProperty('--search-exit-transform', panelStyle.transform)
    dialog.style.setProperty(
      '--search-exit-backdrop-opacity',
      getComputedStyle(dialog, '::backdrop').opacity
    )
    dialog.setAttribute('data-closing', '')
    const animations = dialog.getAnimations()
    if (animations.length > 0) {
      let timeout = 0
      await Promise.race([
        Promise.allSettled(animations.map((animation) => animation.finished)),
        new Promise<void>((resolve) => {
          timeout = window.setTimeout(resolve, 300)
        }),
      ])
      window.clearTimeout(timeout)
    }
    dialog.close()
    dialog.removeAttribute('data-closing')
    return true
  }

  const openMatch = async ({ sessionId, messageId }: SessionSearchResult) => {
    const attempt = ++selection.current
    const available = await loadSessionForSearch(sessionId)
    if (attempt !== selection.current || !dialogRef.current?.open) {
      return
    }
    if (!(await closeDialog())) {
      return
    }
    if (available && selectSession(sessionId, messageId)) {
      closeMobileSider()
    } else {
      showToast(t('searchSessionMissing'))
    }
  }

  const focusResult = (index: number) => {
    const result = listRef.current?.children[index]?.querySelector('button')
    result?.focus({ preventScroll: true })
    result?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-label={t('searchSessions')}
      onCancel={(event) => {
        event.preventDefault()
        void closeDialog()
      }}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        pointerStartedOutside.current =
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom)
      }}
      onClick={(event) => {
        if (pointerStartedOutside.current && event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          ) {
            void closeDialog()
          }
        }
        pointerStartedOutside.current = false
      }}
      onClose={() => {
        selection.current++
        setQuery('')
        setResponse(null)
        onClose()
      }}
    >
      <div className={styles.searchRow}>
        <span className={styles.searchIcon} aria-hidden="true">
          <IconSearchOutline16 />
        </span>
        <input
          ref={inputRef}
          className={styles.input}
          type="search"
          aria-label={t('searchSessions')}
          placeholder={t('searchSessionsPlaceholder')}
          value={query}
          onChange={(event) => {
            if (event.target.value.trim().replace(/\s+/g, ' ') !== keyword) {
              selection.current++
              setResponse(null)
            }
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              void closeDialog()
            }
            if (matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              focusResult(event.key === 'ArrowDown' ? 0 : matches.length - 1)
            }
            if (event.key === 'Enter' && matches[0]) {
              event.preventDefault()
              openMatch(matches[0])
            }
          }}
        />
        <div className={styles.closeControl}>
          <IconButton
            icon={<IconCloseOutline16 />}
            size="xl"
            aria-label={t('close')}
            onClick={() => void closeDialog()}
          />
        </div>
      </div>
      <div
        className={styles.results}
        data-expanded={Boolean(keyword)}
        {...(!keyword ? { inert: '' } : {})}
      >
        <div className={styles.resultsClip}>
          <div className={styles.resultsScroll}>
            <div role="status" className={status && keyword ? styles.status : undefined}>
              {keyword ? status : ''}
            </div>
            {loading ? <div className={styles.loadingPreview} aria-hidden="true" /> : null}
            {failed ? (
              <button
                type="button"
                className={styles.result}
                onClick={() => {
                  if (!ready) {
                    void initChat()
                  } else {
                    setRetry((attempt) => attempt + 1)
                  }
                }}
              >
                {t('retry')}
              </button>
            ) : null}
            {matches.length > 0 ? (
              <ul ref={listRef} className={styles.list}>
                {matches.map((match, index) => (
                  <li key={JSON.stringify([match.sessionId, match.messageId])}>
                    <button
                      type="button"
                      className={styles.result}
                      onClick={() => void openMatch(match)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp') {
                          event.preventDefault()
                          if (index === 0) {
                            inputRef.current?.focus({ preventScroll: true })
                          } else {
                            focusResult(index - 1)
                          }
                        }
                        if (event.key === 'ArrowDown') {
                          event.preventDefault()
                          focusResult(index + 1)
                        }
                      }}
                    >
                      <span className={styles.resultTitle}>
                        {match.titleMatch ? <Highlight match={match.titleMatch} /> : match.title}
                      </span>
                      {match.excerpt ? (
                        <span className={styles.excerpt}>
                          <Highlight match={match.excerpt} />
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </dialog>
  )
}
