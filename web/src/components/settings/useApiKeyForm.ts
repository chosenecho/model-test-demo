import { useState } from 'react'
import { ApiError, login } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setSessionExpiresAt } from '../../services/settings.js'
import { initChat, syncRemoteSessions } from '../../services/chat/store.js'
import { useTranslate } from '../../i18n/index.js'

/** 提交邀请码换取会话 Cookie；前端只记到期时间，凭证不进 localStorage */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const submit = async () => {
    const code = value.trim()
    if (!code || verifying) {
      return
    }
    setVerifying(true)
    setFailure(null)
    try {
      const session = await login(code)
      setSessionExpiresAt(session.expiresAt)
      setValue('')
      // 登录后把这台设备本地的工作区和账号对齐（初始化已完成时也要补一次拉取）
      void initChat().then(() => syncRemoteSessions()).catch(() => undefined)
      onSaved?.()
    } catch (e) {
      setFailure({ cause: e })
    } finally {
      setVerifying(false)
    }
  }

  return { value, setValue, verifying, error, submit }
}
