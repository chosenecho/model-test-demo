import { getVisibleMessages } from './branches.js'
import { loadSession } from './db.js'
import { useChatStore } from './store.js'
import type { Message, SessionSummary } from './types.js'
import { buildReplyView } from './view.js'

export type SearchMatch = { before: string; keyword: string; after: string }

export type SessionSearchResult = {
  sessionId: string
  title: string
  titleMatch?: SearchMatch
  messageId?: string
  excerpt?: SearchMatch
}

const BATCH_SIZE = 8
const EXCERPT_CONTEXT = 48

const findMatch = (text: string, pattern: RegExp, context: number): SearchMatch | undefined => {
  const match = pattern.exec(text)
  if (!match) {
    return
  }
  const start = match.index
  const end = start + match[0].length
  return {
    before: `${start > context ? '…' : ''}${text.slice(Math.max(0, start - context), start)}`,
    keyword: match[0],
    after: `${text.slice(end, end + context)}${text.length - end > context ? '…' : ''}`,
  }
}

const messageText = (message: Message) => {
  if (message.role === 'user') {
    return message.content
  }
  if (
    message.stopReason === 'refusal' ||
    message.status === 'pending' ||
    message.status === 'streaming'
  ) {
    return ''
  }
  return buildReplyView(message, false).answer?.text ?? ''
}

export const searchSessions = async (
  sessions: SessionSummary[],
  keyword: string,
  untitled: string,
  signal: AbortSignal
) => {
  const pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  const results: SessionSearchResult[] = []
  let failed = false

  for (let offset = 0; offset < sessions.length && !signal.aborted; offset += BATCH_SIZE) {
    const cache = useChatStore.getState().sessionCache
    const batch = await Promise.allSettled(
      sessions.slice(offset, offset + BATCH_SIZE).map(async ({ id, title }) => {
        const label = title || untitled
        const titleMatch = findMatch(label, pattern, Infinity)
        const matches: SessionSearchResult[] = titleMatch
          ? [{ sessionId: id, title: label, titleMatch }]
          : []
        const session = Object.hasOwn(cache, id) ? cache[id] : await loadSession(id)
        if (session && !signal.aborted) {
          for (const message of getVisibleMessages(session)) {
            const text = messageText(message).replace(/\s+/g, ' ')
            const excerpt = findMatch(text, pattern, EXCERPT_CONTEXT)
            if (excerpt) {
              matches.push({ sessionId: id, title: label, messageId: message.id, excerpt })
            }
          }
        }
        return { matches, missing: !session }
      })
    )
    for (const [index, result] of batch.entries()) {
      if (result.status === 'fulfilled') {
        results.push(...result.value.matches)
        failed ||= result.value.missing
      } else {
        failed = true
        const { id, title } = sessions[offset + index]
        const label = title || untitled
        const titleMatch = findMatch(label, pattern, Infinity)
        if (titleMatch) {
          results.push({ sessionId: id, title: label, titleMatch })
        }
      }
    }
    // Let typing and dialog dismissal run between batches, including cache-only reads.
    if (offset + BATCH_SIZE < sessions.length && !signal.aborted) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    }
  }
  return { results, failed }
}
