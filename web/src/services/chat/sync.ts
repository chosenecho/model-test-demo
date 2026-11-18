import { useSettings } from '../settings.js'
import * as db from './db.js'
import type { AssistantMessage, Message, Session, SessionSummary, UserMessage } from './types.js'

/**
 * 会话同步：本地 IndexedDB 仍是主库，服务端只存副本。
 * - 推送：本地保存成功后延迟合并，同一会话只发最后一次快照
 * - 拉取：启动时对比 updatedAt，服务端更新才覆盖本地（换设备继续聊）
 * - 删除：本地删成功后再软删服务端
 * 未登录、离线、服务端报错都只记控制台，不打断对话。
 */

/** 合并窗口：流式结束后连续落盘只发一次 */
const PUSH_DELAY = 2500
/** 单次请求最多推多少条；与服务端单次上限一致（D1 查询预算） */
const PUSH_CHUNK = 200
/** 单会话总量上限，超过就放弃同步（极端长会话，避免几十个请求） */
const MAX_MESSAGES = 2000

type ServerSummary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

type ServerMessage = {
  id: string
  parentId: string | null
  role: 'user' | 'assistant'
  content: Record<string, unknown> | null
  status?: string
  model?: string | null
  thinking?: boolean | null
  search?: boolean | null
  prefix?: boolean
  stopReason?: string | null
  error?: unknown
  usage?: unknown
  createdAt: number
  updatedAt: number
}

const warn = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.warn(`[sync] ${action} failed`, error)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    // 凭证在 HttpOnly Cookie 里；未登录由服务端 401 判定，前端不再自行猜测
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${text.slice(0, 120)}`)
  }
  return (await response.json()) as T
}

/** 生成中或待发的回复不入库：等服务端收尾后由下一次落盘推送完整快照 */
const isSettled = (session: Session) =>
  session.messages.every(
    (message) => message.role !== 'assistant' || (message.status !== 'pending' && message.status !== 'streaming')
  )

const toServerMessage = (message: Message) => ({
  id: message.id,
  parentId: message.parentId ?? null,
  role: message.role,
  content: message,
  status: message.role === 'assistant' ? message.status : 'done',
  model: message.role === 'assistant' ? message.model : null,
  thinking: message.role === 'assistant' ? (message.thinking ?? null) : null,
  search: message.role === 'assistant' ? (message.search ?? null) : null,
  prefix: message.role === 'assistant' ? message.prefix : false,
  stopReason: message.role === 'assistant' ? (message.stopReason ?? null) : null,
  error: message.role === 'assistant' ? (message.error ?? null) : null,
  usage: message.role === 'assistant' ? (message.usage ?? null) : null,
  createdAt: message.createdAt,
  updatedAt: message.createdAt,
})

const fromServerMessage = (row: ServerMessage): Message => {
  const base = (row.content ?? {}) as Record<string, unknown>
  if (row.role === 'assistant') {
    const merged = {
      ...base,
      id: row.id,
      role: 'assistant',
      parentId: row.parentId,
      status: row.status ?? 'done',
      model: row.model ?? null,
      thinking: row.thinking ?? undefined,
      search: row.search ?? undefined,
      prefix: row.prefix ?? false,
      stopReason: row.stopReason ?? undefined,
      error: row.error ?? undefined,
      usage: row.usage ?? undefined,
      createdAt: row.createdAt,
      blocks: Array.isArray(base.blocks) ? base.blocks : [],
    }
    return merged as unknown as AssistantMessage
  }
  const merged = {
    ...base,
    id: row.id,
    role: 'user',
    parentId: row.parentId,
    createdAt: row.createdAt,
    files: Array.isArray(base.files) ? base.files : [],
  }
  return merged as unknown as UserMessage
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** 待推送的最新快照：同一会话只保留最后一份 */
const queued = new Map<string, Session>()
/** 正在请求中的会话，避免并发覆盖 */
const deferred = new Map<string, Session>()
const inFlight = new Set<string>()

const push = async (session: Session) => {
  if (inFlight.has(session.id)) {
    deferred.set(session.id, session)
    return
  }
  if (!isSettled(session) || session.messages.length > MAX_MESSAGES) {
    return
  }
  inFlight.add(session.id)
  try {
    const messages = session.messages.map(toServerMessage)
    const meta = {
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      rootMessageId: session.rootMessageId ?? null,
      model: 'deepseek-flash',
      settings: { ...lastSettings(session), industryAnalyst: session.industryAnalyst === true },
    }
    // 服务端单次最多 200 条（D1 查询预算），按块顺序 PUT；upsert 按消息 id 幂等，多块相加即全量
    for (let i = 0; i < Math.max(1, messages.length); i += PUSH_CHUNK) {
      await request(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...meta, messages: messages.slice(i, i + PUSH_CHUNK) }),
      })
    }
  } catch (error) {
    warn('push session')(error)
  } finally {
    inFlight.delete(session.id)
    const next = deferred.get(session.id)
    if (next) {
      deferred.delete(session.id)
      void push(next)
    }
  }
}

/** 会话级开关快照：取最后一条回答的配置，服务端只用于展示与统计 */
const lastSettings = (session: Session) => {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i]
    if (message.role === 'assistant') {
      return { thinking: message.thinking ?? false, search: message.search ?? false }
    }
  }
  return {}
}

/** 本地落盘成功后调用；同一会话的连续落盘合并成一次推送 */
export const schedulePush = (session: Session) => {
  if (!useSettings.getState().sessionExpiresAt) {
    return
  }
  queued.set(session.id, session)
  const existing = timers.get(session.id)
  if (existing) {
    clearTimeout(existing)
  }
  timers.set(
    session.id,
    setTimeout(() => {
      timers.delete(session.id)
      const latest = queued.get(session.id)
      queued.delete(session.id)
      if (latest) {
        void push(latest)
      }
    }, PUSH_DELAY)
  )
}

/** 页面隐藏或关闭时立刻发出待推送的快照 */
export const flushPushes = () => {
  for (const [id, timer] of timers) {
    clearTimeout(timer)
    timers.delete(id)
    const session = queued.get(id)
    queued.delete(id)
    if (session) {
      void push(session)
    }
  }
}

export const deleteRemoteSession = async (id: string) => {
  if (!useSettings.getState().sessionExpiresAt) {
    return
  }
  try {
    await request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (error) {
    warn('delete session')(error)
  }
}

export const renameRemoteSession = async (id: string, title: string) => {
  if (!useSettings.getState().sessionExpiresAt) {
    return
  }
  try {
    await request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })
  } catch (error) {
    warn('rename session')(error)
  }
}

/**
 * 启动时拉取服务端列表：本地没有的补进来，服务端更新的覆盖本地。
 * 返回新增或更新的摘要，调用方合并进列表。任何失败都返回空数组。
 */
export const pullRemoteSessions = async (): Promise<SessionSummary[]> => {
  if (!useSettings.getState().sessionExpiresAt) {
    return []
  }
  let remote: ServerSummary[]
  try {
    const data = await request<{ sessions: ServerSummary[] }>('/api/sessions')
    remote = data.sessions
  } catch (error) {
    warn('list sessions')(error)
    return []
  }
  if (remote.length === 0) {
    return []
  }
  const local = new Map((await db.loadSessionSummaries()).map((item) => [item.id, item]))
  const changed: SessionSummary[] = []
  for (const summary of remote) {
    const existing = local.get(summary.id)
    if (existing && existing.updatedAt >= summary.updatedAt) {
      continue
    }
    try {
      const data = await request<{
        session: { rootMessageId: string | null; settings?: { industryAnalyst?: boolean } }
        messages: ServerMessage[]
      }>(`/api/sessions/${encodeURIComponent(summary.id)}`)
      const session: Session = {
        id: summary.id,
        title: summary.title,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        rootMessageId: data.session.rootMessageId ?? null,
        industryAnalyst: data.session.settings?.industryAnalyst === true,
        messages: data.messages.map(fromServerMessage),
      }
      await db.saveSession(session)
      changed.push({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt })
    } catch (error) {
      warn(`pull session ${summary.id}`)(error)
    }
  }
  return changed
}
