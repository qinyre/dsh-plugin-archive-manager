/** Unit tests for the rail's pure core: uniform tick building, long-session
 * capping, the fisheye distance ladder, and the preview time formatting. */

import { describe, expect, it } from 'vitest'
import {
  assistantTextOf,
  buildTicks,
  capTicks,
  formatRelative,
  mergeTicks,
  nearestTickIndex,
  railGeometry,
  railThumbHeight,
  REPLY_CHARS,
  TICK_BASE_WIDTH,
  TICK_FOCUS_WIDTH,
  TICK_PITCH,
  tickCenterY,
  ticksShareKey,
  tickStyleFor,
  tickTierFor,
  tickWidthFor,
  userTextOf,
  type RailNode,
  type Tick,
} from './rail-core.ts'

const node = (kind: string, data: RailNode['data']): RailNode => ({ kind, data })

describe('userTextOf', () => {
  it('joins text blocks and trims', () => {
    expect(userTextOf([{ type: 'text', text: ' fix ' }, { type: 'text', text: 'the bug' }])).toBe('fix the bug')
  })
  it('ignores non-text blocks', () => {
    expect(userTextOf([{ type: 'image', source: 'x' }])).toBe('')
  })
})

describe('assistantTextOf', () => {
  it('joins text blocks and trims', () => {
    expect(assistantTextOf([{ kind: 'text', text: ' fix ' }, { kind: 'text', text: 'the bug' }])).toBe('fix the bug')
  })
  it('skips reasoning and non-text kinds', () => {
    expect(assistantTextOf([
      { kind: 'reasoning', text: 'hidden chain' },
      { kind: 'tool-call', name: 'x' },
      { kind: 'text', text: 'visible' },
    ])).toBe('visible')
  })
})

describe('buildTicks', () => {
  const nodes = new Map<string, RailNode>([
    ['u1', node('user', { time: 100, content: [{ type: 'text', text: 'first' }] })],
    ['a1', node('assistant-step', { blocks: [{ kind: 'text', text: 'answer one' }] })],
    ['t1', node('tool', {})],
    ['u2', node('user', { time: 200, content: [{ type: 'text', text: 'second' }] })],
    ['r1', node('retry', {})],
    ['a2', node('assistant-step', { blocks: [{ kind: 'reasoning', text: 'hidden' }, { kind: 'text', text: 'answer two' }] })],
    ['a2b', node('assistant-step', { blocks: [{ kind: 'text', text: 'more' }] })],
    ['u3', node('user', { time: 300, content: [{ type: 'text', text: 'third' }] })],
  ])
  const order = ['u1', 'a1', 't1', 'u2', 'r1', 'a2', 'a2b', 'u3']

  it('makes one tick per user message with the agent reply of its turn', () => {
    const ticks = buildTicks(order, nodes)
    expect(ticks).toEqual([
      { key: 'u1', text: 'first', time: 100, reply: 'answer one' },
      { key: 'u2', text: 'second', time: 200, reply: 'answer two more' },
      { key: 'u3', text: 'third', time: 300, reply: '' },
    ])
  })

  it('caps the stored reply at REPLY_CHARS (bare assistant kind also folds)', () => {
    const long = 'x'.repeat(200)
    const local = new Map<string, RailNode>([
      ['u', node('user', { content: [{ type: 'text', text: 'q' }] })],
      ['a1', node('assistant', { blocks: [{ kind: 'text', text: long }] })],
      ['a2', node('assistant', { blocks: [{ kind: 'text', text: long }] })],
      ['a3', node('assistant', { blocks: [{ kind: 'text', text: 'tail' }] })],
    ])
    const ticks = buildTicks(['u', 'a1', 'a2', 'a3'], local)
    expect(ticks[0]?.reply.length).toBe(REPLY_CHARS)
    expect(ticks[0]?.reply.startsWith(long)).toBe(true)
  })

  it('ignores assistant, tool and retry nodes without a user tick', () => {
    expect(buildTicks(['a1', 't1', 'r1'], nodes)).toEqual([])
  })

  it('degrades on unknown kinds and missing data', () => {
    const local = new Map([['u', node('user', {})], ['z', node('strange', {})]])
    expect(buildTicks(['z', 'u', 'z2'], local)).toEqual([{ key: 'u', text: '', time: 0, reply: '' }])
  })

  it('returns empty for empty snapshots', () => {
    expect(buildTicks([], new Map())).toEqual([])
  })
})

describe('capTicks', () => {
  const many: Tick[] = Array.from({ length: 1000 }, (_, i) => ({ key: `k${i}`, text: `t${i}`, time: i, reply: '' }))
  it('passes through short lists unchanged (but copied)', () => {
    const short = many.slice(0, 5)
    expect(capTicks(short)).not.toBe(short)
    expect(capTicks(short)).toEqual(short)
  })
  it('caps very long lists and always keeps the newest tick', () => {
    const capped = capTicks(many, 100)
    expect(capped.length).toBe(100)
    expect(capped[capped.length - 1]?.key).toBe('k999')
    expect(new Set(capped).size).toBe(capped.length)
  })
})

describe('mergeTicks', () => {
  const server: Tick[] = [
    { key: 'old', text: 'indexed old', time: 1, reply: '' },
    { key: 'mid', text: 'indexed mid (capped)', time: 2, reply: 'r' },
  ]
  const live: Tick[] = [
    { key: 'mid', text: 'loaded mid — full text', time: 2, reply: 'fuller' },
    { key: 'new', text: 'fresh message', time: 3, reply: '' },
  ]
  it('keeps index order, lets loaded turns win, appends live-only turns', () => {
    expect(mergeTicks(server, live)).toEqual([
      { key: 'old', text: 'indexed old', time: 1, reply: '' },
      { key: 'mid', text: 'loaded mid — full text', time: 2, reply: 'fuller' },
      { key: 'new', text: 'fresh message', time: 3, reply: '' },
    ])
  })
  it('degrades to the live side alone when the index is empty or absent', () => {
    expect(mergeTicks([], live)).toEqual(live)
  })
})

describe('ticksShareKey', () => {
  const tick = (key: string): Tick => ({ key, text: '', time: 0, reply: '' })
  it('detects overlap between the index and the loaded window', () => {
    expect(ticksShareKey([tick('a'), tick('b')], [tick('x'), tick('b')])).toBe(true)
    expect(ticksShareKey([tick('a')], [tick('b')])).toBe(false)
  })
  it('answers false while either side is empty (inconclusive)', () => {
    expect(ticksShareKey([], [tick('a')])).toBe(false)
    expect(ticksShareKey([tick('a')], [])).toBe(false)
  })
})

describe('column geometry', () => {
  it('centers the column while it fits, growing symmetrically from the middle', () => {
    const g5 = railGeometry(5, 400)
    expect(g5.columnH).toBe(5 * TICK_PITCH)
    expect(g5.colTop).toBe(155)
    expect(g5.scrollMax).toBe(0)
    expect(tickCenterY(2, g5, 0)).toBe(200)
    const g7 = railGeometry(7, 400)
    expect(tickCenterY(3, g7, 0)).toBe(200)
  })
  it('turns top-anchored with its own scroll range on overflow', () => {
    const g = railGeometry(50, 360)
    expect(g.colTop).toBe(0)
    expect(g.scrollMax).toBe(50 * TICK_PITCH - 360)
    expect(tickCenterY(0, g, 0)).toBe(TICK_PITCH / 2)
    expect(tickCenterY(49, g, g.scrollMax)).toBe(360 - TICK_PITCH / 2)
  })
  it('maps pointer Y to the nearest tick, clamped at both ends', () => {
    const g = railGeometry(3, 400)
    expect(nearestTickIndex(0, g, 0)).toBe(0)
    expect(nearestTickIndex(191, g, 0)).toBe(1)
    expect(nearestTickIndex(400, g, 0)).toBe(2)
    const o = railGeometry(50, 360)
    expect(nearestTickIndex(0, o, 0)).toBe(0)
    expect(nearestTickIndex(300, o, 270)).toBe(31)
  })
  it('shrinks the thumb as the column grows, with a floor', () => {
    expect(railThumbHeight(railGeometry(5, 400))).toBe(400)
    expect(railThumbHeight(railGeometry(50, 360))).toBe(144)
    expect(railThumbHeight(railGeometry(400, 200))).toBe(16)
  })
})

describe('fisheye ladder', () => {
  it('steps widths 26/20/17/14 then base', () => {
    expect(tickWidthFor(0)).toBe(TICK_FOCUS_WIDTH)
    expect(tickWidthFor(1)).toBe(20)
    expect(tickWidthFor(2)).toBe(17)
    expect(tickWidthFor(3)).toBe(14)
    expect(tickWidthFor(4)).toBe(TICK_BASE_WIDTH)
    expect(tickWidthFor(50)).toBe(TICK_BASE_WIDTH)
  })
  it('steps tiers focus/near/mid then rest', () => {
    expect(tickTierFor(0)).toBe('focus')
    expect(tickTierFor(1)).toBe('near')
    expect(tickTierFor(2)).toBe('mid')
    expect(tickTierFor(3)).toBe('rest')
    expect(tickTierFor(9)).toBe('rest')
  })
  it('no focus (pointer away) puts every tick at rest', () => {
    for (let index = 0; index < 8; index += 1) {
      expect(tickStyleFor(index, null)).toEqual({ width: TICK_BASE_WIDTH, tier: 'rest' })
    }
  })
  it('with focus at 5, widths rise toward the focus and never exceed it', () => {
    const widths = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => tickStyleFor(index, 5).width)
    expect(widths).toEqual([12, 14, 17, 20, 26, 20, 17, 14, 12])
  })
})

describe('formatRelative', () => {
  const now = Date.parse('2026-08-17T12:00:00Z')
  it('buckets recent times', () => {
    expect(formatRelative(now - 10_000, now)).toBe('刚刚')
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 小时前')
  })
  it('renders yesterday and older with a date', () => {
    expect(formatRelative(now - 30 * 3_600_000, now)).toMatch(/^昨天 \d{2}:\d{2}$/)
    expect(formatRelative(now - 10 * 86_400_000, now)).toMatch(/^\d+\/\d+ \d{2}:\d{2}$/)
  })
  it('returns empty for unknown times', () => {
    expect(formatRelative(0, now)).toBe('')
    expect(formatRelative(Number.NaN, now)).toBe('')
  })
})
