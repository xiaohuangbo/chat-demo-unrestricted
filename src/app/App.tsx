import { useEffect } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
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
import { ToolApprovalDialog } from '../components/agent/ToolApprovalDialog.js'
import { StatsDialog } from '../components/session/StatsDialog.js'
import { LabView } from '../components/lab/LabView.js'
import { ErrorBoundary } from '../components/base/ErrorBoundary.js'
import { closeLab, useLab } from '../services/lab/labStore.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { NanoVMHost } from '../components/nanovm/NanoVMHost.js'
import { isLocalModel, isWebllmModel, webllmModelId } from '../services/local/catalog.js'
import { loadModel, refreshDownloaded } from '../services/local/engine.js'
import { useLocalModels } from '../services/local/store.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
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
  const labOpen = useLab((state) => state.open)

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入 API Key；选中本地模型时不需要云端 Key
    if (!isLocalModel(useSettings.getState().model)) {
      ensureApiKey()
    }
  }, [])

  // 自动加载：开启后刷新页面即把上次的浏览器模型放进显存，失败时静默（设置页能看到原因）
  useEffect(() => {
    const model = useSettings.getState().model
    if (!useLocalModels.getState().autoLoad || !isWebllmModel(model)) {
      return
    }
    const modelId = webllmModelId(model)
    void (async () => {
      if (!useLocalModels.getState().catalogSynced) {
        await refreshDownloaded([modelId])
      }
      if (useLocalModels.getState().downloaded[modelId]) {
        await loadModel(modelId)
      }
    })().catch(() => {})
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
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
          <div className={styles.workspace}>
            <div className={styles.content}>
              {siderCollapsed ? <CollapsedSider /> : null}
              {labOpen ? (
                <ErrorBoundary
                  fallback={(error) => (
                    <div className={styles.labFallback}>
                      <div>{t('labRenderError')}</div>
                      <pre className={styles.labFallbackDetail}>{error.message}</pre>
                      <Button variant="outlined" size="m" onClick={closeLab}>
                        {t('labBack')}
                      </Button>
                    </div>
                  )}
                >
                  <LabView />
                </ErrorBoundary>
              ) : !ready || (activeId !== null && !session) ? (
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
            <NanoVMHost />
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      <StatsDialog />
      <ToolApprovalDialog />
      <Toast />
    </>
  )
}
