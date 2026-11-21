import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data' | 'skills'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有会话时打开设置并选中邀请码所在的「数据管理」，返回是否已登录 */
export const ensureApiKey = () => {
  // 只做本地缓存判断，用来决定是否弹设置；真实有效性由服务端 401 决定
  if (useSettings.getState().sessionExpiresAt) {
    return true
  }
  openSettings('data')
  return false
}
