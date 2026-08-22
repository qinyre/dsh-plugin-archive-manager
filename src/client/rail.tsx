/** The conversation ruler: one dash per user message along the inside-left
 * of the conversation pane (right beside the sidebar, never over it) — a
 * Codex-style fisheye (Focus+Context) rail.
 *
 * At rest every dash is identical (same width, color, opacity — node type,
 * status and content length never change a tick's look). When the pointer
 * enters the ruler's transparent strip, the tick nearest the pointer Y
 * becomes the focus: it stretches and darkens, and its neighbors stretch by
 * distance, producing a continuous wave that follows the mouse. Click jumps
 * to that message (loading older pages first, flashing the row); the focus
 * tick also shows a text preview; Alt+↑/↓ steps between messages.
 *
 * Density is constant: the tick pitch never changes with message count.
 * While the column fits the rail height it stays vertically centered — new
 * ticks grow it symmetrically from the middle. Once it overflows, the column
 * turns top-anchored (oldest first) and the rail scrolls it with its own
 * mini scrollbar (wheel or thumb drag), following the newest tick by
 * default. The conversation itself is never scrolled by the rail's own bar.
 *
 * Tick data comes from two sources, joined per turn key. The server-side
 * index (`/dsh-plugin-atlas/rail`) supplies the durable full-history column
 * without pulling a single page through the host ChatView — driving that
 * pagination eagerly loaded the entire conversation into a non-virtualized
 * list whose window then persisted for the session, making every later
 * switch into it re-render everything. The live session snapshot supplies
 * whatever is actually loaded (fresher text) plus brand-new turns. If the
 * index is unavailable or its keys stop matching the snapshot's context-key
 * format, the component falls back to the legacy behavior: build ticks from
 * the snapshot alone and back-fill the full history through `loadAll`.
 *
 * The component is mounted per session through a session-scoped slot child;
 * `useSession` subscribes to the chat snapshot, `jump` scrolls to a node key,
 * `loadAll` back-fills older pages (fallback only). */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useComposerHistory } from './composer-history.ts'
import {
  buildTicks,
  capTicks,
  formatRelative,
  mergeTicks,
  nearestTickIndex,
  railGeometry,
  railThumbHeight,
  tickCenterY,
  ticksShareKey,
  tickStyleFor,
  TICK_PITCH,
  type Tick,
} from './rail-core.ts'

/** Ruler geometry (px): RAIL_WIDTH is the transparent pointer strip, not the
 * dash length — dashes live inside it, left-anchored, and never reach far
 * into the content column. The strip sits INSIDE the conversation pane, a
 * hair off its left edge (which is the sidebar boundary) — never on the
 * sidebar itself. */
const RAIL_WIDTH = 34
const RAIL_EDGE_INSET = 4
/** The reading line sits 40% down the scrollport — the same convention the
 * shell's own reading-position logic uses. Only used to seed Alt+↑/↓. */
const READING_LINE_RATIO = 0.4

/** Scrollport DOM contract (product-rendered attributes). */
function findScrollport(): HTMLElement | null {
  return document.querySelector('[data-conversation-scroll]')
}

/** rAF-throttled scheduling helper. */
function scheduleRaf(callback: () => void): () => void {
  let queued = false
  return () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      callback()
    })
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max))

export interface RailProps {
  /** Slot-framework session hook: subscribe to the chat snapshot. */
  useSession: <T>(select: (state: unknown) => T) => T
  sessionId: string
  /** Scroll to a node key; resolves false when the row never appears. */
  jump: (key: string) => Promise<boolean>
  /** Back-fill the full history (legacy fallback only); receives a disposed flag. */
  loadAll: ((disposed: () => boolean) => Promise<void>) | undefined
  /** Server-side tick index for this session; rejects when unavailable. */
  ticks?: () => Promise<readonly Tick[]>
  /** Locale lookup for aria labels and the preview bubble. */
  t: (key: string) => string
}

export function Rail(props: RailProps): React.ReactElement {
  const { useSession, jump, loadAll, t } = props

  const order = useSession((s: unknown) => {
    const chat = (s as { chat?: { order?: string[] } } | null)?.chat
    return chat?.order
  })
  const nodes = useSession((s: unknown) => {
    const chat = (s as { chat?: { nodes?: Map<string, unknown> } } | null)?.chat
    return chat?.nodes
  })

  const liveTicks = useMemo(
    () => capTicks(buildTicks(order ?? [], (nodes ?? new Map()) as Map<string, never>)),
    [order, nodes],
  )

  // Server-side history index. `pending` until the fetch settles (the column
  // then shows just the live window), `ready` once it landed, `legacy` when
  // the index is unavailable or its keys stopped matching the snapshot —
  // legacy rebuilds ticks from the snapshot alone and back-fills through
  // loadAll, the pre-0.2.3 behavior.
  const [indexState, setIndexState] = useState<'pending' | 'ready' | 'legacy'>('pending')
  const [indexed, setIndexed] = useState<readonly Tick[]>([])
  const ticksFetcherRef = useRef(props.ticks)
  ticksFetcherRef.current = props.ticks

  useEffect(() => {
    let cancelled = false
    setIndexState('pending')
    setIndexed([])
    const fetcher = ticksFetcherRef.current
    if (fetcher === undefined) { setIndexState('legacy'); return }
    fetcher().then(
      rows => { if (!cancelled) { setIndexed(rows); setIndexState('ready') } },
      () => { if (!cancelled) setIndexState('legacy') },
    )
    return () => { cancelled = true }
  }, [props.sessionId])

  const ticks = useMemo(
    () => indexState === 'ready' ? capTicks(mergeTicks(indexed, liveTicks)) : liveTicks,
    [indexState, indexed, liveTicks],
  )

  // Terminal-style composer history (ArrowUp/ArrowDown recall of this
  // session's sent messages) rides the same session-scoped subscription.
  useComposerHistory(order, nodes, props.sessionId)

  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const [railBox, setRailBox] = useState<{ top: number; left: number; height: number } | null>(null)
  /** Rail's own scroll: explicit px offset, replaced by tail-follow whenever
   * the user parks the rail at the very bottom (so new ticks keep the
   * newest visible without stealing an inspected position). */
  const [userScroll, setUserScroll] = useState(0)
  const [followTail, setFollowTail] = useState(true)
  const ticksRef = useRef(ticks)
  ticksRef.current = ticks

  const viewportH = railBox?.height ?? 0
  const geom = railGeometry(ticks.length, viewportH)
  const scrollTop = followTail ? geom.scrollMax : Math.min(userScroll, geom.scrollMax)

  // Handlers read geometry through a ref — the rAF/native callbacks must
  // always see the latest rendered values.
  const viewRef = useRef({ geom, scrollTop })
  viewRef.current = { geom, scrollTop }

  const applyScroll = (next: number): void => {
    const max = viewRef.current.geom.scrollMax
    const clamped = clamp(next, 0, max)
    setUserScroll(clamped)
    setFollowTail(clamped >= max)
  }

  // Legacy back-fill, only while the server index is not trusted (fetch
  // failed, old host without the inject, or a key-format mismatch below):
  // indexes every message so jumps into old turns still work, at the cost of
  // pulling the whole history through the ChatView.
  const loadAllRef = useRef(loadAll)
  loadAllRef.current = loadAll
  useEffect(() => {
    if (indexState !== 'legacy') return
    const disposed = { current: false }
    const loader = loadAllRef.current
    if (loader !== undefined) void loader(() => disposed.current).catch(() => {})
    return () => { disposed.current = true }
  }, [props.sessionId, indexState])

  // Key-format guard: once the live window has landed with at least one tick,
  // the index must share a key with it. No overlap means a future dsh build
  // changed its context-key shape — drop to the legacy path rather than
  // render a column whose clicks can never land.
  useEffect(() => {
    if (indexState !== 'ready') return
    if (liveTicks.length === 0) return
    if (!ticksShareKey(indexed, liveTicks)) setIndexState('legacy')
  }, [indexState, indexed, liveTicks])

  // Track the scrollport's box so the ruler hugs its left edge through
  // sidebar collapse, resize, and conversation layout shifts.
  useLayoutEffect(() => {
    const measure = scheduleRaf(() => {
      const port = findScrollport()
      if (port === null) { setRailBox(null); return }
      const rect = port.getBoundingClientRect()
      if (rect.height === 0) { setRailBox(null); return }
      setRailBox({
        top: rect.top,
        left: Math.round(rect.left + RAIL_EDGE_INSET),
        height: rect.height,
      })
    })
    measure()
    const observer = new ResizeObserver(measure)
    const port = findScrollport()
    if (port !== null) observer.observe(port)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // A shrinking tick list (session switch) can orphan the focus index.
  useEffect(() => {
    setFocusIndex(current => current !== null && current >= ticks.length ? null : current)
  }, [ticks.length])

  // Fisheye tracking: nearest tick to the pointer Y in the CURRENT scroll
  // position. rAF-throttled, and only state CHANGES re-render — a
  // stationary pointer costs nothing. Suppressed while dragging the thumb.
  const railRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const eventClientY = useRef(0)
  const onPointerMove = scheduleRaf(() => {
    const rail = railRef.current
    const { geom: g, scrollTop: st } = viewRef.current
    if (rail === null || draggingRef.current || g.count === 0) return
    const rect = rail.getBoundingClientRect()
    if (rect.height === 0) return
    const index = nearestTickIndex(eventClientY.current - rect.top, g, st)
    setFocusIndex(current => current === index ? current : index)
  })
  const handlePointerMove = (event: React.PointerEvent): void => {
    eventClientY.current = event.clientY
    onPointerMove()
  }

  // The rail's own wheel scroll. Native listener because React's onWheel is
  // passive at the root; we consume the delta only while the rail can
  // actually scroll in that direction, so page scrolling never feels eaten.
  useEffect(() => {
    const rail = railRef.current
    if (rail === null) return
    const onWheel = (event: WheelEvent): void => {
      const { geom: g, scrollTop: st } = viewRef.current
      if (g.scrollMax <= 0) return
      const next = clamp(st + event.deltaY, 0, g.scrollMax)
      if (next === st) return
      event.preventDefault()
      applyScroll(next)
    }
    rail.addEventListener('wheel', onWheel, { passive: false })
    return () => { rail.removeEventListener('wheel', onWheel) }
  }, [railBox !== null])

  // Thumb drag: pointer capture keeps the drag alive outside the 3px thumb.
  const thumbRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ y: number; scroll: number } | null>(null)
  const thumbH = railThumbHeight(geom)
  const onThumbPointerDown = (event: React.PointerEvent): void => {
    event.preventDefault()
    thumbRef.current?.setPointerCapture(event.pointerId)
    dragRef.current = { y: event.clientY, scroll: scrollTop }
    draggingRef.current = true
  }
  const onThumbPointerMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current
    if (drag === null || railBox === null) return
    const track = Math.max(1, railBox.height - thumbH)
    const ratio = viewRef.current.geom.scrollMax / track
    applyScroll(drag.scroll + (event.clientY - drag.y) * ratio)
  }
  const endThumbDrag = (): void => {
    dragRef.current = null
    draggingRef.current = false
  }

  // Keyboard: Alt+↑/↓ jumps between messages; never while typing. The step
  // anchor is the tick nearest the reading line, measured on demand.
  const jumpRef = useRef(jump)
  jumpRef.current = jump
  useEffect(() => {
    const nearestToReadingLine = (): number => {
      const port = findScrollport()
      if (port === null) return -1
      const rect = port.getBoundingClientRect()
      if (rect.height === 0) return -1
      const line = rect.top + rect.height * READING_LINE_RATIO
      const keyToIndex = new Map(ticksRef.current.map((tick, index) => [tick.key, index]))
      let best = -1
      let bestDist = Infinity
      for (const row of Array.from(port.querySelectorAll('[data-chat-anchor-key]'))) {
        const index = keyToIndex.get(row.getAttribute('data-chat-anchor-key') ?? '')
        if (index === undefined) continue
        const box = row.getBoundingClientRect()
        const dist = Math.abs(box.top + box.height / 2 - line)
        if (dist < bestDist) { bestDist = dist; best = index }
      }
      return best
    }
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (target instanceof HTMLElement && target.isContentEditable) return
      const current = ticksRef.current
      const first = current[0]
      if (current.length === 0 || first === undefined) return
      const at = nearestToReadingLine()
      const base = at >= 0 ? at : current.length - 1
      const next = event.key === 'ArrowUp' ? Math.max(0, base - 1) : Math.min(current.length - 1, base + 1)
      event.preventDefault()
      void jumpRef.current(current[next]?.key ?? first.key)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  const empty = ticks.length === 0 || railBox === null
  const focused = focusIndex !== null ? ticks[focusIndex] : undefined
  const thumbTop = geom.scrollMax > 0 && railBox !== null
    ? (scrollTop / geom.scrollMax) * (railBox.height - thumbH)
    : 0

  return (
    <div
      ref={railRef}
      className={`dsha-rail${empty ? ' dsha-rail-empty' : ''}`}
      style={railBox === null ? undefined : {
        top: `${railBox.top}px`,
        left: `${railBox.left}px`,
        height: `${railBox.height}px`,
        width: `${RAIL_WIDTH}px`,
      }}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => { setFocusIndex(null) }}
    >
      {empty ? null : (
        <>
          <div className="dsha-rail-view">
            <div
              className="dsha-rail-col"
              style={{ transform: `translateY(${geom.colTop - scrollTop}px)` }}
            >
              {ticks.map((tick, index) => {
                const style = tickStyleFor(index, focusIndex)
                return (
                  <button
                    key={tick.key}
                    type="button"
                    className={`dsha-tick is-${style.tier}`}
                    style={{ '--tick-w': `${style.width}px`, height: `${TICK_PITCH}px` } as React.CSSProperties}
                    tabIndex={-1}
                    aria-label={tick.text === '' ? t('rail.previewEmpty') : tick.text.slice(0, 80)}
                    onClick={() => { void jump(tick.key) }}
                  />
                )
              })}
            </div>
          </div>
          {geom.scrollMax > 0 && railBox !== null ? (
            <div
              ref={thumbRef}
              className="dsha-railbar-thumb"
              role="scrollbar"
              aria-orientation="vertical"
              aria-label={t('rail.scrollLabel')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((scrollTop / geom.scrollMax) * 100)}
              style={{ top: `${thumbTop}px`, height: `${thumbH}px` }}
              onPointerDown={onThumbPointerDown}
              onPointerMove={onThumbPointerMove}
              onPointerUp={endThumbDrag}
              onPointerCancel={endThumbDrag}
            />
          ) : null}
          {focused !== undefined && focusIndex !== null && railBox !== null ? (
            <div
              className="dsha-preview"
              style={{
                top: `${clamp(tickCenterY(focusIndex, geom, scrollTop) - 24, 0, Math.max(0, railBox.height - 180))}px`,
              }}
            >
              <div className="dsha-preview-meta">
                <span>{formatRelative(focused.time, Date.now())}</span>
              </div>
              <div className="dsha-preview-user">
                {focused.text === '' ? t('rail.previewEmpty') : focused.text}
              </div>
              {focused.reply !== '' ? (
                <div className="dsha-preview-agent">{focused.reply}</div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
