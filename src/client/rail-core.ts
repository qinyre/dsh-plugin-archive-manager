/** Pure rail logic: tick building and the fisheye (Focus+Context) geometry.
 * No DOM, no React — exhaustively unit-testable.
 *
 * Data source is the client chat snapshot (the same nodes the conversation
 * renders): `order` lists node keys, `nodes` maps key → { kind, data }. User
 * nodes become ticks — one per turn, the granularity worth jumping between.
 *
 * Every tick is visually IDENTICAL at rest: node type, status, tool activity
 * and content length never influence a tick's look. The only thing that
 * changes a tick is the pointer's proximity (see `tickStyleFor`). */

/** One rail tick: a user message plus the agent's reply in that turn. */
export interface Tick {
  /** Node key — the same value `data-chat-anchor-key` carries in the DOM. */
  readonly key: string
  /** Trimmed user text for the hover preview. */
  readonly text: string
  /** Unix epoch ms from the user node. */
  readonly time: number
  /** Agent text for the hover preview: text-kind blocks of the assistant
   * nodes in this turn (reasoning is skipped), capped at REPLY_CHARS. */
  readonly reply: string
}

/** Stored agent-text cap (px-independent insurance for 400-tick sessions). */
export const REPLY_CHARS = 400

/** Structural node shape the rail reads (defensive: every field optional).
 * `kind` is the conversation DEFINITION kind, not the payload kind — the
 * assistant row registers as 'assistant-step' ('assistant' is the payload's
 * own kind field and never appears as a node kind). */
export interface RailNode {
  readonly kind?: string
  readonly data?: {
    readonly time?: number
    readonly content?: readonly unknown[]
    readonly blocks?: readonly unknown[]
  }
}

/** Extract readable text from a user node's content blocks. */
export function userTextOf(content: readonly unknown[] | undefined): string {
  if (content === undefined) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { type?: unknown; text?: unknown }).text
    if (typeof text === 'string') out += text
  }
  return out.trim()
}

/** Extract the agent's visible reply text from assistant blocks (text kind
 * only — reasoning stays hidden, exactly like the conversation renders). */
export function assistantTextOf(blocks: readonly unknown[] | undefined): string {
  if (blocks === undefined) return ''
  let out = ''
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const { kind, text } = block as { kind?: unknown; text?: unknown }
    if (kind === 'text' && typeof text === 'string') out += text
  }
  return out.trim()
}

/**
 * Build ordered ticks from the chat snapshot: one per user message, each
 * carrying the agent text that followed it (until the next user message).
 * @param order - node keys in conversation order.
 * @param nodes - key → node map.
 */
export function buildTicks(order: readonly string[], nodes: ReadonlyMap<string, RailNode>): Tick[] {
  const ticks: (Tick & { reply: string })[] = []
  const appendReply = (tick: Tick & { reply: string }, text: string): void => {
    if (text === '' || tick.reply.length >= REPLY_CHARS) return
    tick.reply = tick.reply === '' ? text : `${tick.reply} ${text}`
    if (tick.reply.length > REPLY_CHARS) tick.reply = tick.reply.slice(0, REPLY_CHARS)
  }
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined) continue
    if (node.kind === 'user') {
      ticks.push({
        key,
        text: userTextOf(node.data?.content),
        time: typeof node.data?.time === 'number' ? node.data.time : 0,
        reply: '',
      })
      continue
    }
    const tick = ticks[ticks.length - 1]
    if (tick === undefined) continue
    // 'assistant-step' is the real snapshot kind; bare 'assistant' kept as a
    // defensive alias in case a future version renames the definition.
    if (node.kind === 'assistant-step' || node.kind === 'assistant') {
      appendReply(tick, assistantTextOf(node.data?.blocks))
    }
  }
  return ticks
}

/** DOM cap: beyond this, evenly subsample (the last tick is always kept so
 * "jump to newest" never loses its target). */
export const MAX_TICKS = 400

/** Evenly decimate ticks for very long sessions. */
export function capTicks(ticks: readonly Tick[], max = MAX_TICKS): Tick[] {
  if (ticks.length <= max) return [...ticks]
  const out: Tick[] = []
  const step = ticks.length / max
  for (let i = 0; i < max; i += 1) out.push(ticks[Math.floor(i * step)] as Tick)
  const last = ticks[ticks.length - 1] as Tick
  if (out[out.length - 1] !== last) out[out.length - 1] = last
  return out
}

/**
 * Merge the server-side index with the live snapshot's ticks. A turn whose
 * key is loaded renders from the snapshot (full uncapped text — the index
 * caps previews for transport); turns only the index knows keep their
 * indexed row. Live-only entries (messages newer than the index read) append
 * in order. The index supplies the durable full-history ordering, so the
 * merged column stays chronological without either side being complete.
 */
export function mergeTicks(server: readonly Tick[], live: readonly Tick[]): Tick[] {
  const liveByKey = new Map(live.map(tick => [tick.key, tick]))
  const merged = server.map(tick => liveByKey.get(tick.key) ?? tick)
  const indexed = new Set(server.map(tick => tick.key))
  for (const tick of live) {
    if (!indexed.has(tick.key)) merged.push(tick)
  }
  return merged
}

/** Whether at least one indexed key also exists among the live ticks — the
 * rail's check that the server key format still matches what the snapshot
 * actually renders. Empty on either side counts as no overlap (the caller
 * waits for a real window before drawing conclusions). */
export function ticksShareKey(server: readonly Tick[], live: readonly Tick[]): boolean {
  if (server.length === 0 || live.length === 0) return false
  const liveKeys = new Set(live.map(tick => tick.key))
  return server.some(tick => liveKeys.has(tick.key))
}

// ---------------------------------------------------------------------------
// Column geometry
//
// Tick pitch is CONSTANT — density never changes with message count. While
// the column fits the rail height it stays vertically centered (each new
// tick grows it symmetrically from the middle); once it overflows, the
// column is top-anchored (oldest first, newest last) and the rail scrolls
// it with its own mini scrollbar.

/** Vertical distance between tick centers (px), independent of everything. */
export const TICK_PITCH = 18
/** Shortest the mini-scrollbar thumb may get (px). */
export const RAIL_THUMB_MIN = 16

export interface RailGeometry {
  /** Tick count the geometry was computed for. */
  readonly count: number
  /** Viewport (rail strip) height the geometry was computed for. */
  readonly viewportH: number
  /** Tick pitch the geometry was computed with. */
  readonly pitch: number
  /** Total column height: count × pitch. */
  readonly columnH: number
  /** Top offset of the column inside the viewport at scrollTop 0 — the
   * centering margin while it fits, 0 once it overflows. */
  readonly colTop: number
  /** Maximum scrollTop (0 while it fits). */
  readonly scrollMax: number
}

export function railGeometry(count: number, viewportH: number, pitch = TICK_PITCH): RailGeometry {
  const columnH = count * pitch
  const fits = columnH <= viewportH
  return {
    count,
    viewportH,
    pitch,
    columnH,
    colTop: fits ? (viewportH - columnH) / 2 : 0,
    scrollMax: fits ? 0 : columnH - viewportH,
  }
}

/** A tick's center Y in viewport coordinates at the given scrollTop. */
export function tickCenterY(index: number, g: RailGeometry, scrollTop: number): number {
  return g.colTop + (index + 0.5) * g.pitch - scrollTop
}

/** The tick nearest a pointer Y (viewport coordinates), clamped to range. */
export function nearestTickIndex(yView: number, g: RailGeometry, scrollTop: number): number {
  const raw = Math.round((yView - g.colTop + scrollTop) / g.pitch - 0.5)
  return Math.min(g.count - 1, Math.max(0, raw))
}

/** Mini-scrollbar thumb height for the geometry (px). */
export function railThumbHeight(g: RailGeometry): number {
  if (g.columnH <= 0 || g.viewportH <= 0) return RAIL_THUMB_MIN
  return Math.min(g.viewportH, Math.max(RAIL_THUMB_MIN, (g.viewportH * g.viewportH) / g.columnH))
}

// ---------------------------------------------------------------------------
// Fisheye geometry
//
// At rest every dash is BASE px long. When the pointer is inside the ruler,
// the tick nearest the pointer Y is the focus and its neighbors stretch by
// distance — a localized fisheye. Ticks beyond HOVER_RADIUS stay at base.
// Colors follow the shell's theme label tokens through four tiers, so light
// and dark themes both work without any hardcoded palette.

/** Resting dash width (px). */
export const TICK_BASE_WIDTH = 12
/** Focus dash width (px) — the tick under the pointer. */
export const TICK_FOCUS_WIDTH = 26
/** How many ticks on EACH side of the focus still stretch. */
export const HOVER_RADIUS = 3

/** Distance→width ladder: focus 26, then 20 / 17 / 14, rest 12. Anything
 * at or beyond the ladder (including no focus at all) reads as base. */
export function tickWidthFor(distance: number): number {
  if (distance <= 0) return TICK_FOCUS_WIDTH
  if (distance === 1) return 20
  if (distance === 2) return 17
  if (distance === 3) return 14
  return TICK_BASE_WIDTH
}

/** Color tier for a tick at `distance` from the focus. Maps onto
 * --dsw-alias-label-{primary,secondary,tertiary,dimmed}. */
export type TickTier = 'focus' | 'near' | 'mid' | 'rest'

export function tickTierFor(distance: number): TickTier {
  if (distance <= 0) return 'focus'
  if (distance === 1) return 'near'
  if (distance === 2) return 'mid'
  return 'rest'
}

/** Style inputs for one tick given the current focus (null = pointer away,
 * everything at rest). */
export interface TickStyle {
  readonly width: number
  readonly tier: TickTier
}

export function tickStyleFor(index: number, focusIndex: number | null): TickStyle {
  const distance = focusIndex === null ? Infinity : Math.abs(index - focusIndex)
  return { width: tickWidthFor(distance), tier: tickTierFor(distance) }
}

/** Relative-time label for the hover bubble (zh style, matching the shell). */
export function formatRelative(ms: number, now: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = now - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (diff < 172_800_000) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
