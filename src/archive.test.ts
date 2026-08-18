/** Unit tests for the archive core: preview extraction, row building, and
 * the unarchive funnel (including its unsupported-build guard). */

import { describe, expect, it, vi } from 'vitest'
import {
  buildArchiveRows, previewOfLog, textOfUserMessage, unarchiveIds, UnarchiveUnsupportedError,
} from './archive.ts'
import type { EventLike, RegistryWriteSurface } from './types.ts'

const userEvent = (seq: number, text: string, time = 1000): EventLike =>
  ({ type: 'user/message', seq, time, data: { content: [{ type: 'text', text }] } })

describe('textOfUserMessage', () => {
  it('joins text blocks', () => {
    expect(textOfUserMessage({ content: [{ type: 'text', text: 'hi ' }, { type: 'text', text: 'there' }] })).toBe('hi there')
  })
  it('accepts plain-string payloads', () => {
    expect(textOfUserMessage('plain')).toBe('plain')
  })
  it('returns empty on unusable shapes', () => {
    expect(textOfUserMessage(null)).toBe('')
    expect(textOfUserMessage({ content: 42 })).toBe('')
    expect(textOfUserMessage({ content: [{ type: 'image' }] })).toBe('')
  })
})

describe('previewOfLog', () => {
  it('extracts title, last user, turns, and last activity', () => {
    const log: EventLike[] = [
      userEvent(1, 'first question', 1_000),
      { type: 'turn/start', seq: 2, time: 1_100, data: { turn: 1 } },
      { type: 'turn/end', seq: 3, time: 1_200, data: { turn: 1, reason: { kind: 'completed' } } },
      userEvent(4, 'second question', 1_300),
      { type: 'turn/end', seq: 5, time: 1_400, data: { turn: 2, reason: { kind: 'completed' } } },
      { type: 'assistant/message', seq: 6, time: 1_500, data: {} },
    ]
    expect(previewOfLog(log)).toEqual({
      title: 'first question', lastUser: 'second question', turns: 2, lastActivityMs: 1_500,
    })
  })
  it('truncates long previews', () => {
    const long = 'x'.repeat(500)
    const preview = previewOfLog([userEvent(1, long)])
    expect(preview.title?.length).toBe(200)
  })
  it('handles empty logs', () => {
    expect(previewOfLog([])).toEqual({ title: null, lastUser: null, turns: 0, lastActivityMs: null })
  })
})

describe('buildArchiveRows', () => {
  const headers = [
    { id: 's1', createdAt: 10, cwd: '/a' },
    { id: 's2', createdAt: 20 },
  ]
  const workspaces = [
    { id: 'w1', title: 'Proj', path: '/a', sessionIds: ['s2'] },
  ]
  it('joins headers and workspace accounting', () => {
    const rows = buildArchiveRows(['s1', 's2'], headers, workspaces)
    expect(rows[0]).toMatchObject({ id: 's1', cwd: '/a', workspaceId: null })
    expect(rows[1]).toMatchObject({ id: 's2', cwd: null, workspaceId: 'w1', workspaceTitle: 'Proj' })
  })
  it('survives missing headers', () => {
    const rows = buildArchiveRows(['ghost'], headers, workspaces)
    expect(rows[0]).toMatchObject({ id: 'ghost', createdAt: 0, cwd: null })
  })
})

describe('unarchiveIds', () => {
  const makeRegistry = (archived: string[]): RegistryWriteSurface & { state: { archivedSessionIds: string[] } } => {
    const registry = {
      archivedSessionIds: archived,
      state: { archivedSessionIds: archived },
      setState: vi.fn(async (next: Record<string, unknown>) => {
        registry.state = next as { archivedSessionIds: string[] }
        registry.archivedSessionIds = (next as { archivedSessionIds: string[] }).archivedSessionIds
      }),
      archiveSession: vi.fn(),
      list: () => [],
    }
    return registry as unknown as RegistryWriteSurface & { state: { archivedSessionIds: string[] } }
  }

  it('removes the given ids through the state funnel', async () => {
    const registry = makeRegistry(['a', 'b', 'c'])
    const next = await unarchiveIds(registry, ['b', 'ghost'])
    expect(next).toEqual(['a', 'c'])
    expect(registry.state.archivedSessionIds).toEqual(['a', 'c'])
    expect(registry.archivedSessionIds).toEqual(['a', 'c'])
  })

  it('is a no-op (no write) when nothing matches', async () => {
    const registry = makeRegistry(['a'])
    const next = await unarchiveIds(registry, ['ghost'])
    expect(next).toEqual(['a'])
    expect(registry.setState).not.toHaveBeenCalled()
  })

  it('refuses builds without the funnel', async () => {
    const registry = makeRegistry(['a'])
    delete (registry as unknown as Record<string, unknown>).setState
    await expect(unarchiveIds(registry, ['a'])).rejects.toBeInstanceOf(UnarchiveUnsupportedError)
  })

  it('refuses when the registry is not started', async () => {
    const registry = makeRegistry(['a'])
    delete (registry as unknown as Record<string, unknown>).state
    await expect(unarchiveIds(registry, ['a'])).rejects.toThrow('not started')
  })
})
