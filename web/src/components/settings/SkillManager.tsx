import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { setIndustryAnalyst, useChatStore } from '../../services/chat/store.js'
import styles from './SkillManager.module.css'

/** 项目方提供的预设 Skill；前端只切换当前会话配置，指令由 Worker 注入。 */
export const SkillManager = () => {
  const t = useTranslate()
  const available = useSettings((state) => state.chatFeatures?.industry_analyst === true)
  const featuresLoaded = useSettings((state) => state.chatFeatures !== null)
  const offlinePreview = !featuresLoaded && window.location.protocol === 'file:'
  const activeId = useChatStore((state) => state.activeId)
  const enabled = useChatStore((state) =>
    state.activeId === null
      ? state.draftIndustryAnalyst
      : state.sessionCache[state.activeId]?.industryAnalyst === true
  )
  const busy = useChatStore((state) => state.importingHistory)
  const sessionLoaded = useChatStore(
    (state) => state.activeId === null || !!state.sessionCache[state.activeId]
  )
  return (
    <div className={styles.manager}>
      <p className={styles.hint}>{t('skillServerHint')}</p>
      <div className={styles.item}>
        <div className={styles.summary}>
          <strong id="industry-analyst-name">{t('industryAnalyst')}</strong>
          <p id="industry-analyst-description">{t('skillAnalystDescription')}</p>
        </div>
        <label className={styles.control}>
          <input
            type="checkbox"
            role="switch"
            aria-labelledby="industry-analyst-name"
            aria-describedby="industry-analyst-description skill-scope"
            checked={enabled}
            disabled={(!available && !offlinePreview) || busy || !sessionLoaded}
            onChange={(event) => setIndustryAnalyst(activeId, event.target.checked)}
          />
        </label>
      </div>
      <p id="skill-scope" className={styles.hint}>
        {t('skillSessionHint')}
      </p>
      {!available ? (
        <p role="status" className={styles.hint}>
          {t(featuresLoaded ? 'skillUnavailable' : 'skillNeedsAccount')}
        </p>
      ) : null}
    </div>
  )
}
