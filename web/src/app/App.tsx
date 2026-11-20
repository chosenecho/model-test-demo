import { useEffect, useRef, useState, type MouseEvent } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../i18n/index.js'
import { me } from '../services/api/client.js'
import { setSessionExpiresAt, setSiderCollapsed, useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { SessionSearch } from '../components/sider/SessionSearch.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  const sessionExpiresAt = useSettings((state) => state.sessionExpiresAt)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  const sessionSearchRef = useRef<HTMLDialogElement>(null)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const openSessionSearch = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.focus({ preventScroll: true })
    sessionSearchRef.current?.showModal()
    setSessionSearchOpen(true)
  }
  const toggleSider = (collapsed: boolean) => {
    setSiderCollapsed(collapsed)
    requestAnimationFrame(() => {
      const toggle = document.getElementById(
        collapsed ? 'expand-desktop-sider' : 'collapse-desktop-sider'
      )
      toggle?.focus({ preventScroll: true })
    })
  }

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  useEffect(() => {
    if (sessionExpiresAt === null) {
      return
    }
    const controller = new AbortController()
    let refreshing = false
    const refresh = async () => {
      if (refreshing) {
        return
      }
      refreshing = true
      try {
        const current = await me(controller.signal)
        if (
          controller.signal.aborted ||
          useSettings.getState().sessionExpiresAt !== sessionExpiresAt
        ) {
          return
        }
        if (current) {
          useSettings.setState({ chatFeatures: current.chat_features })
        } else {
          setSessionExpiresAt(null)
        }
      } catch {
        // 网络错误时保留本次会话最近一次确认的可用性，窗口重新获焦时重试。
      } finally {
        refreshing = false
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('focus', refresh)
    }
  }, [sessionExpiresAt])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入邀请码
    ensureApiKey()
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? (
          <MobileSider onSearch={openSessionSearch} />
        ) : (
          <div
            className={clsx(styles.desktopSider, siderCollapsed && styles.desktopSiderCollapsed)}
            {...(siderCollapsed ? { inert: '' } : {})}
          >
            <div className={styles.desktopSiderContent}>
              <Sider onSearch={openSessionSearch} onCollapse={() => toggleSider(true)} />
            </div>
          </div>
        )}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {!isMobile ? (
              <CollapsedSider
                visible={siderCollapsed}
                onSearch={openSessionSearch}
                onExpand={() => toggleSider(false)}
              />
            ) : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
        <SessionSearch
          dialogRef={sessionSearchRef}
          open={sessionSearchOpen}
          onClose={() => setSessionSearchOpen(false)}
        />
      </div>
      <SettingsDialog />
      <Toast />
    </>
  )
}
