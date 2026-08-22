/** railTicksOfLog: persisted-log → tick-index folding. Covers the key format
 * mirror, append-surface filtering, reply folding/caps, and the defensive
 * skips that keep a malformed log from producing dead ticks. */

import { describe, expect, it } from 'vitest'
import { railTickKey, railTicksOfLog } from './rail-index.ts'
import type { EventLike } from './types.ts'

let seq = 0
const event = (parts: Omit<EventLike, 'seq'>): EventLike => ({ ...parts, seq: seq += 1 })

const userMessage = (
  id: string,
  text: string,
  opts: { time?: number; source?: unknown; surfaceOp?: unknown } = {},
): EventLike => event({
  type: 'user/message',
  time: opts.time ?? 0,
  surfaceOp: opts.surfaceOp ?? 'append',
  data: { id, content: [{ type: 'text', text }], source: opts.source ?? { kind: 'user' } },
})

const assistantMessage = (...blocks: { type: string; text?: string }[]): EventLike => event({
  type: 'assistant/message',
  time: 0,
  surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { id: 'a1', content: blocks }, usage: undefined },
})

describe('railTicksOfLog', () => {
  it('indexes ordinary user turns under the runtime input-message context keys', () => {
    const ticks = railTicksOfLog([
      userMessage('m1', '  first question  ', { time: 111 }),
      assistantMessage({ type: 'reasoning', text: 'secret thoughts' }, { type: 'text', text: 'first answer' }),
      event({ type: 'tool/result', time: 5, surfaceOp: 'append', data: { message: { content: [] } } }),
      userMessage('m2', 'second question', { time: 222 }),
      assistantMessage({ type: 'text', text: 'second answer' }),
    ])
    expect(ticks).toEqual([
      { key: '13:input-messagem1', text: 'first question', time: 111, reply: 'first answer' },
      { key: '13:input-messagem2', text: 'second question', time: 222, reply: 'second answer' },
    ])
  })

  it('folds consecutive assistant text into one capped reply', () => {
    const ticks = railTicksOfLog([
      userMessage('m1', 'q'),
      assistantMessage({ type: 'text', text: 'a'.repeat(300) }),
      assistantMessage({ type: 'text', text: 'b'.repeat(300) }),
    ])
    expect(ticks).toHaveLength(1)
    expect(ticks[0]?.reply.length).toBe(400)
    expect(ticks[0]?.reply.startsWith('a'.repeat(300))).toBe(true)
  })

  it('skips compaction checkpoints, injected context, and non-user sources', () => {
    const ticks = railTicksOfLog([
      userMessage('c1', 'compacted summary', { source: { kind: 'plugin', plugin: 'compact' } }),
      userMessage('c2', 'injected reminder', { source: { kind: 'plugin', plugin: 'agent-instructions' } }),
      userMessage('c3', 'from another agent', { source: { kind: 'subagent' } }),
      userMessage('m1', 'real question'),
    ])
    expect(ticks.map(tick => tick.key)).toEqual(['13:input-messagem1'])
  })

  it('ignores replacement-surface copies, unmarked events, and assistant chunks', () => {
    const ticks = railTicksOfLog([
      userMessage('r1', 'replacement copy', { surfaceOp: { op: 'replace', start: 1, end: 2 } }),
      { type: 'user/message', seq: seq += 1, time: 0, data: { id: 'u1', content: [{ type: 'text', text: 'no marker' }], source: { kind: 'user' } } },
      event({ type: 'assistant/chunk', time: 0, surfaceOp: undefined as unknown as never, data: { chunk: { type: 'text-delta', index: 0, text: 'streamed' } } }),
      userMessage('m1', 'real'),
    ])
    expect(ticks.map(tick => tick.key)).toEqual(['13:input-messagem1'])
    expect(ticks[0]?.reply).toBe('')
  })

  it('caps tick text and skips messages without a usable id', () => {
    const ticks = railTicksOfLog([
      userMessage('', 'no id'),
      { type: 'user/message', seq: seq += 1, time: 9, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'still no id' }], source: { kind: 'user' } } },
      userMessage('m1', 'x'.repeat(600)),
    ])
    expect(ticks).toHaveLength(1)
    expect(ticks[0]?.text.length).toBe(500)
  })

  it('returns an empty index for an empty or foreign log', () => {
    expect(railTicksOfLog([])).toEqual([])
    expect(railTicksOfLog([
      event({ type: 'turn/start', time: 1, surfaceOp: undefined as unknown as never, data: { turn: 1 } }),
    ])).toEqual([])
  })

  it('mirrors conversationContextKey(kind, id) = `${len}:${kind}${id}`', () => {
    expect(railTickKey('abc')).toBe('13:input-messageabc')
  })
})
