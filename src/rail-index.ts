/** Server-side rail index: fold a persisted session log into the tick list
 * the conversation ruler renders — without pulling a single history page
 * through the host ChatView.
 *
 * Why this exists: the rail used to index history by driving the client's own
 * pagination (`loadOlder` until `hasMore` drops). Every landing page is a
 * full non-virtualized ChatView re-commit, and the loaded window persists for
 * the session's lifetime — after one back-fill, every later switch into that
 * conversation re-rendered the whole history. Serving ticks straight from the
 * durable log keeps the chat window at its tail page and makes conversation
 * switches O(window) again.
 *
 * Keys mirror the web runtime's conversation context keys for the
 * input-message definition (`conversationContextKey(kind, id)` =
 * `${kind.length}:${kind}${id}`), so a click can jump straight at the DOM
 * row. The rail verifies that shape against the live snapshot once the
 * window lands and falls back to the legacy back-fill if a future dsh build
 * renames it.
 *
 * Deliberate divergence from the client-side tick builder: a claimed
 * steering message also becomes a tick. Its persisted row is indistinguishable
 * from an ordinary turn (the claim state lives in client inbox state), it
 * shares the same context key, and jumping to it works — it is a real user
 * message. */

import { textOfUserMessage } from './archive.ts'
import type { EventLike } from './types.ts'

/** One indexed conversation turn: the same shape the rail's Tick renders. */
export interface RailTick {
  readonly key: string
  readonly text: string
  readonly time: number
  readonly reply: string
}

/** Stored tick-text cap (the wire payload stays small; previews clamp harder). */
export const TICK_TEXT_CHARS = 500
/** Stored agent-text cap (mirrors the client builder's REPLY_CHARS). */
const REPLY_CHARS = 400

/** The conversation definition kind whose nodes the rail counts. */
const INPUT_MESSAGE_KIND = 'input-message'

/** Length-prefixed context key — mirrors conversationContextKey('input-message', id). */
export function railTickKey(messageId: string): string {
  return `${INPUT_MESSAGE_KIND.length}:${INPUT_MESSAGE_KIND}${messageId}`
}

/** Append-origin surface events only: replacement copies shadow model history,
 * never the human transcript, and unmarked rows predate the surface layer. */
function isAppendSurface(event: EventLike): boolean {
  return (event as { surfaceOp?: unknown }).surfaceOp === 'append'
}

/** The `source.kind` of a message event's data ('user' for ordinary turns). */
function sourceKindOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const source = (data as { source?: unknown }).source
  if (source === null || typeof source !== 'object') return ''
  const kind = (source as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : ''
}

/** The jumpable message id of a message event's data, when present. */
function messageIdOf(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null
  const id = (data as { id?: unknown }).id
  if (id === undefined || id === null) return null
  const text = String(id)
  return text === '' ? null : text
}

/** Visible reply text from an assistant/message payload: `{ message: { content } }`
 * text blocks (reasoning stays hidden, exactly like the conversation renders). */
function assistantTextOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const content = (data as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string') out += text
  }
  return out.trim()
}

interface TickBuilder {
  key: string
  text: string
  time: number
  reply: string
}

/**
 * Fold a persisted log into ordered rail ticks: one per ordinary user
 * message, each carrying the assistant text that followed it (until the next
 * user message). Malformed rows degrade silently — a missing id yields no
 * tick (it could never be jumped to), a malformed assistant payload yields
 * no reply text.
 * @param events - persisted session events in log order.
 */
export function railTicksOfLog(events: readonly EventLike[]): RailTick[] {
  const ticks: TickBuilder[] = []
  let current: TickBuilder | null = null
  for (const event of events) {
    if (event.type === 'user/message') {
      if (!isAppendSurface(event)) continue
      const data = event.data
      if (sourceKindOf(data) !== 'user') continue
      const id = messageIdOf(data)
      if (id === null) continue
      current = {
        key: railTickKey(id),
        text: textOfUserMessage(data).slice(0, TICK_TEXT_CHARS),
        time: typeof event.time === 'number' ? event.time : 0,
        reply: '',
      }
      ticks.push(current)
      continue
    }
    if (event.type === 'assistant/message' && isAppendSurface(event) && current !== null) {
      const text = assistantTextOf(event.data)
      if (text === '' || current.reply.length >= REPLY_CHARS) continue
      current.reply = current.reply === '' ? text : `${current.reply} ${text}`
      if (current.reply.length > REPLY_CHARS) current.reply = current.reply.slice(0, REPLY_CHARS)
    }
  }
  return ticks
}
