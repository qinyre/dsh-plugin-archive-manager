/** Terminal-style input history for the conversation composer: pressing
 * ArrowUp inside the message box walks backwards through this session's sent
 * user messages and puts each one straight into the draft (ArrowDown walks
 * forward; the in-progress draft is captured on the first recall and restored
 * on the way back down) — the same muscle memory as a shell's history.
 *
 * The pointer machine is pure and unit-tested here; the DOM half is a hook the
 * Rail mounts (it already owns the session-scoped chat snapshot subscription
 * the history is built from). Interception is deliberately conservative:
 *
 * - only the composer textarea (`[data-composer-card]`), never other inputs;
 * - never during IME composition, nor while the box is disabled/read-only;
 * - never while any popup listbox is open (command menu owns the arrows);
 * - from the live draft, ArrowUp recalls only with a collapsed caret at the
 *   very START of the text and ArrowDown only at its very END — with the
 *   caret anywhere else (mid-word, mid-line, over a selection) the arrows
 *   keep moving the caret natively, so editing a draft is never hijacked.
 *   Mid-walk (a recalled entry is showing) the arrows keep driving the
 *   history walk from any caret position, exactly like a shell;
 * - any edit the recall machinery did not perform (typing, pasting, the
 *   post-send clear) resets the pointer to the live slot, like a shell.
 *
 * Writing the recalled text goes through the native value setter plus an
 * `input` event so the host's controlled textarea picks it up as an ordinary
 * edit (verified against the rc.8 web composer's machine onChange path). */

import { useEffect, useRef } from 'react'
import { userTextOf, type RailNode } from './rail-core.ts'

// ---------------------------------------------------------------------------
// Pure pointer machine
// ---------------------------------------------------------------------------

/** The recall pointer. `offset` 0 is the live draft slot (nothing recalled);
 * k > 0 addresses `history[history.length - k]`. `savedDraft` holds the
 * in-progress draft captured on the first ArrowUp, restored at offset 0. */
export interface RecallState {
  readonly offset: number
  readonly savedDraft: string
}

export const LIVE_SLOT: RecallState = { offset: 0, savedDraft: '' }

/** The chat node face the history reads: whatever `get` returns is narrowed
 * internally (the rail's session selector hands over a Map<string, unknown>). */
export type HistoryNodeReader = { get(key: string): unknown }

/** Build the recall history from the chat snapshot: one entry per user
 * message, in conversation order. Consecutive duplicates collapse (re-sending
 * the same text back-to-back must not make ArrowUp walk through echoes), and
 * empty texts never make it in. */
export function buildHistory(order: readonly string[], nodes: HistoryNodeReader): string[] {
  const out: string[] = []
  for (const key of order) {
    const entry = nodes.get(key)
    if (entry === null || typeof entry !== 'object') continue
    const { kind, data } = entry as RailNode
    if (kind !== 'user') continue
    const text = userTextOf(data?.content)
    if (text === '' || text === out[out.length - 1]) continue
    out.push(text)
  }
  return out
}

/** The box content the recall machinery expects for this state. */
function expectedText(state: RecallState, history: readonly string[]): string {
  return state.offset === 0 ? state.savedDraft : history[history.length - state.offset] ?? ''
}

/** One arrow press. `actual` is the CURRENT box content; when it differs from
 * what the machinery last put there (typing, paste, the post-send clear), the
 * pointer resets to the live slot first — exactly a shell's behavior after
 * editing a line.
 *
 * @returns the next state plus the text to place in the box, or null when the
 * key must fall through to the host (already at the oldest/newest end). */
export function applyRecallKey(
  state: RecallState,
  history: readonly string[],
  key: 'up' | 'down',
  actual: string,
): { state: RecallState; text: string } | null {
  if (history.length === 0) return null
  let current = state
  if (expectedText(current, history) !== actual) {
    current = { offset: 0, savedDraft: actual }
  }
  if (key === 'up') {
    if (current.offset >= history.length) return null
    const offset = current.offset + 1
    return { state: { offset, savedDraft: current.savedDraft }, text: history[history.length - offset] ?? '' }
  }
  if (current.offset === 0) return null
  const offset = current.offset - 1
  const text = offset === 0 ? current.savedDraft : history[history.length - offset] ?? ''
  return { state: { offset, savedDraft: current.savedDraft }, text }
}

/** Should this arrow drive the recall walk (`true`) or fall through to the
 * host's native caret movement? Mid-walk (`live` false — the box holds what
 * the machinery last wrote) the arrows keep walking history from any caret
 * position, like a shell. From the live draft, ArrowUp recalls only with a
 * collapsed caret at the very start of the text and ArrowDown only at its
 * very end; any other caret position (mid-word, mid-line, mid-selection)
 * moves natively first. */
export function shouldRecallArrow(
  key: 'up' | 'down',
  live: boolean,
  caretStart: number,
  caretEnd: number,
  textLength: number,
): boolean {
  if (!live) return true
  if (caretStart !== caretEnd) return false
  return key === 'up' ? caretStart === 0 : caretEnd === textLength
}

// ---------------------------------------------------------------------------
// DOM half
// ---------------------------------------------------------------------------

/** The native value setter of HTMLTextAreaElement, used to write the recalled
 * text into the host's controlled textarea (React overrides `value` on the
 * instance; only the prototype setter actually stores the text). Resolved
 * lazily so importing the module outside a browser (unit tests) stays safe. */
function textareaValueSetter(): ((value: string) => void) | undefined {
  if (typeof HTMLTextAreaElement === 'undefined') return undefined
  return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
}

/** Is the event target the conversation composer's textarea? The composer card
 * carries the product-rendered `data-composer-card` attribute; the label is
 * localized, so the marker — not the text — identifies the box. */
function isComposerTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.closest('[data-composer-card]') !== null
}

/** Attach the composer history to the session the Rail renders: `order`/
 * `nodes` are the same chat snapshot selections the ticks use. The history is
 * built lazily on the first arrow press (and re-built only when the snapshot
 * changes afterwards), keeping back-fill page storms off the render path. */
export function useComposerHistory(
  order: readonly string[] | undefined,
  nodes: HistoryNodeReader | undefined,
  sessionId: string,
): void {
  const snapshotRef = useRef({ order, nodes })
  snapshotRef.current = { order, nodes }
  const historyRef = useRef<{ nodes: HistoryNodeReader | undefined; history: string[] }>({
    nodes: undefined,
    history: [],
  })
  const stateRef = useRef<RecallState>(LIVE_SLOT)

  // A session switch must not leak a pointer (or a saved draft) across.
  useEffect(() => {
    stateRef.current = LIVE_SLOT
  }, [sessionId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      if (!isComposerTextarea(event.target)) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      // keyCode 229 is the legacy IME-composition signal engines emit without
      // isComposing; recalling mid-composition would eat the candidate keys.
      if (event.isComposing || event.keyCode === 229) return
      const box = event.target
      if (box.disabled || box.readOnly) return
      // An open popup (command menu, trigger menus) renders a listbox and owns
      // the arrow keys while it exists.
      if (document.querySelector('[role="listbox"]') !== null) return
      const caretStart = box.selectionStart ?? box.value.length
      const caretEnd = box.selectionEnd ?? caretStart
      if (!shouldRecallArrow(
        event.key === 'ArrowUp' ? 'up' : 'down',
        stateRef.current.offset === 0,
        caretStart,
        caretEnd,
        box.value.length,
      )) return
      if (historyRef.current.nodes !== snapshotRef.current.nodes) {
        const snapshot = snapshotRef.current
        historyRef.current = { nodes: snapshot.nodes, history: buildHistory(snapshot.order ?? [], snapshot.nodes ?? new Map<string, unknown>()) }
      }
      const recall = applyRecallKey(
        stateRef.current, historyRef.current.history, event.key === 'ArrowUp' ? 'up' : 'down', box.value,
      )
      const nativeValueSetter = textareaValueSetter()
      if (recall === null || nativeValueSetter === undefined) return
      // Consume before writing: the host's own keydown (arrow arbitration) and
      // the native caret move must both be suppressed for a recalled entry.
      event.preventDefault()
      event.stopPropagation()
      stateRef.current = recall.state
      nativeValueSetter.call(box, recall.text)
      const end = recall.text.length
      box.setSelectionRange(end, end)
      box.dispatchEvent(new Event('input', { bubbles: true }))
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => { window.removeEventListener('keydown', onKey, { capture: true }) }
  }, [])
}
