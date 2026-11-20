import type { MouseEventHandler } from 'react'
import { IconPanelLeftOutline16, IconSearchOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import styles from './Sider.module.css'

/** 收起后左上角的按钮组 */
export const CollapsedSider = ({
  visible,
  onSearch,
  onExpand,
}: {
  visible: boolean
  onSearch: MouseEventHandler<HTMLButtonElement>
  onExpand: () => void
}) => {
  const t = useTranslate()
  return (
    <div className={styles.collapsed} data-visible={visible} {...(!visible ? { inert: '' } : {})}>
      <div className={styles.collapsedGroup}>
        <IconButton
          size="m"
          tone="primary"
          id="expand-desktop-sider"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('expandSiderbarButton')}
          onClick={onExpand}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          onClick={newChat}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<IconSearchOutline16 />}
          tooltip={t('searchSessions')}
          aria-haspopup="dialog"
          onClick={onSearch}
        />
      </div>
    </div>
  )
}
