/** Unit tests for the composer history: snapshot → history building, and the
 * terminal pointer machine (ArrowUp/ArrowDown walk, saved-draft capture and
 * restore, drift reset after a foreign edit or the post-send clear). */

import { describe, expect, it } from 'vitest'
import {
  applyRecallKey,
  buildHistory,
  LIVE_SLOT,
  shouldRecallArrow,
  type RecallState,
} from './composer-history.ts'
import type { RailNode } from './rail-core.ts'

const node = (kind: string, data: RailNode['data']): RailNode => ({ kind, data })

const user = (text: string): RailNode =>
  node('user', { time: 1, content: [{ type: 'text', text }] })

describe('buildHistory', () => {
  it('collects user texts in conversation order', () => {
    const nodes = new Map<string, RailNode>([
      ['u1', user('first')],
      ['a1', node('assistant-step', { blocks: [{ kind: 'text', text: 'answer' }] })],
      ['u2', user('second')],
    ])
    expect(buildHistory(['u1', 'a1', 'u2'], nodes)).toEqual(['first', 'second'])
  })

  it('skips empty texts and collapses consecutive duplicates', () => {
    const nodes = new Map<string, RailNode>([
      ['u1', user('same')],
      ['u2', user('same')],
      ['u3', user('   ')],
      ['u4', user('same')],
      ['u5', user('other')],
    ])
    expect(buildHistory(['u1', 'u2', 'u3', 'u4', 'u5'], nodes)).toEqual(['same', 'other'])
  })

  it('works against a store face (get only), not just a Map', () => {
    const nodes = new Map<string, RailNode>([['u1', user('only')]])
    const store = { get: (key: string) => nodes.get(key) }
    expect(buildHistory(['u1', 'missing'], store)).toEqual(['only'])
  })
})

describe('applyRecallKey', () => {
  const history = ['one', 'two', 'three']

  it('ArrowUp from the live slot saves the draft and recalls the newest', () => {
    const result = applyRecallKey(LIVE_SLOT, history, 'up', 'draft in progress')
    expect(result?.text).toBe('three')
    expect(result?.state).toEqual({ offset: 1, savedDraft: 'draft in progress' })
  })

  it('ArrowUp walks older until the oldest, then falls through', () => {
    let state: RecallState = LIVE_SLOT
    const first = applyRecallKey(state, history, 'up', '')
    expect(first?.text).toBe('three')
    state = first?.state ?? LIVE_SLOT
    const second = applyRecallKey(state, history, 'up', 'three')
    expect(second?.text).toBe('two')
    state = second?.state ?? LIVE_SLOT
    const third = applyRecallKey(state, history, 'up', 'two')
    expect(third?.text).toBe('one')
    state = third?.state ?? LIVE_SLOT
    expect(applyRecallKey(state, history, 'up', 'one')).toBeNull()
  })

  it('ArrowDown walks newer and restores the saved draft at the live slot', () => {
    const atOldest = { offset: 3, savedDraft: 'draft in progress' }
    const down = applyRecallKey(atOldest, history, 'down', 'one')
    expect(down?.text).toBe('two')
    const nearer = applyRecallKey(down?.state ?? atOldest, history, 'down', 'two')
    expect(nearer?.text).toBe('three')
    const live = applyRecallKey(nearer?.state ?? atOldest, history, 'down', 'three')
    expect(live?.text).toBe('draft in progress')
    expect(live?.state.offset).toBe(0)
    expect(applyRecallKey(live?.state ?? atOldest, history, 'down', 'draft in progress')).toBeNull()
  })

  it('a foreign edit resets the pointer to the live slot first', () => {
    const recalling = { offset: 2, savedDraft: 'old draft' }
    // The box now holds a foreign text (typed/pasted/cleared), not the
    // expected 'two': ArrowUp saves THAT text and recalls the newest.
    const result = applyRecallKey(recalling, history, 'up', 'edited text')
    expect(result?.state).toEqual({ offset: 1, savedDraft: 'edited text' })
    expect(result?.text).toBe('three')
    // ArrowDown from the reset state restores the newly saved draft.
    expect(applyRecallKey(result?.state ?? recalling, history, 'down', 'three')?.text).toBe('edited text')
  })

  it('the post-send clear (empty box while recalling) resets like a foreign edit', () => {
    const recalling = { offset: 1, savedDraft: 'sent already' }
    const result = applyRecallKey(recalling, history, 'up', '')
    expect(result?.text).toBe('three')
    expect(result?.state.savedDraft).toBe('')
  })

  it('an empty history never intercepts', () => {
    expect(applyRecallKey(LIVE_SLOT, [], 'up', '')).toBeNull()
    expect(applyRecallKey({ offset: 1, savedDraft: '' }, [], 'down', '')).toBeNull()
  })
})

describe('shouldRecallArrow', () => {
  // "hello" — length 5.
  it('from the live draft, ArrowUp recalls only with the caret at the very start', () => {
    expect(shouldRecallArrow('up', true, 0, 0, 5)).toBe(true)
    expect(shouldRecallArrow('up', true, 2, 2, 5)).toBe(false)
    expect(shouldRecallArrow('up', true, 5, 5, 5)).toBe(false)
  })
  it('from the live draft, ArrowDown recalls only with the caret at the very end', () => {
    expect(shouldRecallArrow('down', true, 5, 5, 5)).toBe(true)
    expect(shouldRecallArrow('down', true, 0, 0, 5)).toBe(false)
    expect(shouldRecallArrow('down', true, 2, 2, 5)).toBe(false)
  })
  it('a selection falls through to the native collapse, even touching an edge', () => {
    expect(shouldRecallArrow('up', true, 0, 3, 5)).toBe(false)
    expect(shouldRecallArrow('down', true, 2, 5, 5)).toBe(false)
  })
  it('an empty draft recalls ArrowUp from the caret (position 0 is both edges)', () => {
    expect(shouldRecallArrow('up', true, 0, 0, 0)).toBe(true)
  })
  it('mid-walk (a recalled entry is showing) the arrows drive history from any caret', () => {
    for (const caret of [0, 2, 5]) {
      expect(shouldRecallArrow('up', false, caret, caret, 5)).toBe(true)
      expect(shouldRecallArrow('down', false, caret, caret, 5)).toBe(true)
    }
  })
})
