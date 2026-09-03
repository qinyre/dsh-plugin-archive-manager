/** Unit tests for auto-archive: rule validation/persistence and the pure
 * selection engine (plus the executor against fakes). */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RULES, loadRules, resolveActivity, runAutoArchive, saveRules, selectAutoArchive, settingsPath, validateRules,
} from './autorules.ts'
import type { ArchiveHost, AutoRules, WorkspaceLike } from './types.ts'

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const tempHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'archive-rules-'))
  tempRoots.push(root)
  return root
}

describe('rules persistence', () => {
  it('round-trips through the settings file', async () => {
    const home = tempHome()
    const rules: AutoRules = { enabled: true, maxIdleDays: 7, perWorkspaceKeep: 5 }
    await saveRules(rules, home)
    expect(await loadRules(home)).toEqual(rules)
    expect(settingsPath(home)).toBe(join(home, 'dsh-plugin-archive-manager.json'))
  })

  it('degrades to defaults on corrupt or missing files', async () => {
    const home = tempHome()
    expect(await loadRules(home)).toEqual(DEFAULT_RULES)
    writeFileSync(settingsPath(home), '{oops', 'utf8')
    expect(await loadRules(home)).toEqual(DEFAULT_RULES)
  })

  it('falls back to the pre-rename dsh-plugin-atlas.json once the new file exists', async () => {
    const home = tempHome()
    const legacy: AutoRules = { enabled: true, maxIdleDays: 90, perWorkspaceKeep: null }
    writeFileSync(join(home, 'dsh-plugin-atlas.json'), JSON.stringify(legacy), 'utf8')
    // legacy only consulted while the new file is absent
    expect(await loadRules(home)).toEqual(legacy)
    const fresh: AutoRules = { enabled: false, maxIdleDays: 7, perWorkspaceKeep: 2 }
    await saveRules(fresh, home)
    expect(await loadRules(home)).toEqual(fresh)
  })
})

describe('validateRules', () => {
  it('accepts sane values and nulls', () => {
    expect(validateRules({ enabled: false, maxIdleDays: null, perWorkspaceKeep: null })).toEqual(
      { enabled: false, maxIdleDays: null, perWorkspaceKeep: null })
    expect(validateRules({ enabled: true, maxIdleDays: 3650, perWorkspaceKeep: 500 })).toEqual(
      { enabled: true, maxIdleDays: 3650, perWorkspaceKeep: 500 })
  })
  it('rejects malformed input', () => {
    expect(validateRules(null)).toBeNull()
    expect(validateRules({ enabled: 'yes' })).toBeNull()
    expect(validateRules({ enabled: true, maxIdleDays: 0 })).toBeNull()
    expect(validateRules({ enabled: true, maxIdleDays: 1.5 })).toBeNull()
    expect(validateRules({ enabled: true, maxIdleDays: 3651 })).toBeNull()
    expect(validateRules({ enabled: true, perWorkspaceKeep: -1 })).toBeNull()
  })
})

const DAY = 86_400_000
const workspaces: WorkspaceLike[] = [
  { id: 'w1', title: 'One', path: '/one', sessionIds: ['fresh', 'stale', 'old-hat', 'live-now', 'archived-already'] },
  { id: 'w2', title: 'Two', path: '/two', sessionIds: ['w2-only'] },
]

const inputOf = (rules: AutoRules, activity: Record<string, number>, now: number) => ({
  workspaces,
  archived: ['archived-already'],
  live: ['live-now'],
  activityById: new Map(Object.entries(activity)),
  rules,
  now,
})

describe('selectAutoArchive', () => {
  const now = 1_000 * DAY

  it('selects nothing while disabled or rule-less', () => {
    expect(selectAutoArchive(inputOf({ enabled: false, maxIdleDays: 7, perWorkspaceKeep: null }, {}, now))).toEqual([])
    expect(selectAutoArchive(inputOf({ enabled: true, maxIdleDays: null, perWorkspaceKeep: null }, {}, now))).toEqual([])
  })

  it('archives idle sessions, skipping archived and live ones', () => {
    const rules: AutoRules = { enabled: true, maxIdleDays: 3, perWorkspaceKeep: null }
    const picked = selectAutoArchive(inputOf(rules, {
      fresh: now - DAY,
      stale: now - 5 * DAY,
      'old-hat': now - 30 * DAY,
      'live-now': now - 90 * DAY,
      'w2-only': now - DAY,
    }, now))
    expect(picked.map(candidate => candidate.sessionId).sort()).toEqual(['old-hat', 'stale'])
    expect(picked.every(candidate => candidate.reason === 'idle')).toBe(true)
  })

  it('keeps the N most-recent per workspace and archives the overflow', () => {
    const rules: AutoRules = { enabled: true, maxIdleDays: null, perWorkspaceKeep: 1 }
    const picked = selectAutoArchive(inputOf(rules, {
      fresh: now - 1,
      stale: now - 2,
      'old-hat': now - 3,
    }, now))
    expect(picked.map(candidate => candidate.sessionId).sort()).toEqual(['old-hat', 'stale'])
    expect(picked.every(candidate => candidate.reason === 'overflow')).toBe(true)
  })

  it('labels a session caught by both rules as idle', () => {
    const rules: AutoRules = { enabled: true, maxIdleDays: 3, perWorkspaceKeep: 1 }
    const picked = selectAutoArchive(inputOf(rules, {
      fresh: now - DAY,
      stale: now - 5 * DAY,
    }, now))
    const stale = picked.find(candidate => candidate.sessionId === 'stale')
    expect(stale?.reason).toBe('idle')
  })

  it('treats unknown activity as the oldest', () => {
    const rules: AutoRules = { enabled: true, maxIdleDays: 1, perWorkspaceKeep: null }
    const picked = selectAutoArchive(inputOf(rules, { fresh: now }, now))
    // w2-only has no resolved activity → 0 → idle
    expect(picked.map(candidate => candidate.sessionId)).toContain('w2-only')
  })
})

describe('resolveActivity', () => {
  it('folds the newest event time', async () => {
    const persistence = {
      list: async () => [],
      inspect: async () => ({
        header: { id: 's', createdAt: 5 },
        log: [
          { type: 'user/message', seq: 1, time: 5, data: {} },
          { type: 'turn/end', seq: 2, time: 50, data: {} },
        ],
      }),
    }
    expect(await resolveActivity(persistence, 's')).toBe(50)
  })
  it('falls back to 0 when inspect fails', async () => {
    const persistence = {
      list: async () => [],
      inspect: async () => { throw new Error('gone') },
    }
    expect(await resolveActivity(persistence, 's')).toBe(0)
  })
})

describe('runAutoArchive', () => {
  const makeHost = (): { host: ArchiveHost; archivedCalls: string[] } => {
    const archivedCalls: string[] = []
    const host: ArchiveHost = {
      webServer: { register: () => () => {} },
      workspaceRegistry: {
        archivedSessionIds: [],
        state: { archivedSessionIds: [] },
        setState: async () => {},
        archiveSession: async (id: string) => { archivedCalls.push(id) },
        list: () => workspaces,
      },
      sessionPersistence: {
        list: async () => [],
        inspect: async () => {
          throw new Error('no logs in this fixture — activity falls back to 0')
        },
      },
      sessions: { get: (id: string) => (id === 'live-now' ? {} : undefined) },
    }
    return { host, archivedCalls }
  }

  it('dry-run selects but never archives', async () => {
    const { host, archivedCalls } = makeHost()
    const result = await runAutoArchive(host, { enabled: true, maxIdleDays: 1, perWorkspaceKeep: null }, true)
    expect(result.archived).toEqual([])
    expect(archivedCalls).toEqual([])
    expect(result.selected.length).toBeGreaterThan(0)
  })

  it('archives through the public API and survives per-session failures', async () => {
    const { host } = makeHost()
    host.workspaceRegistry.archiveSession = vi.fn(async (id: string) => {
      if (id === 'w2-only') throw new Error('boom')
    })
    const result = await runAutoArchive(host, { enabled: true, maxIdleDays: 1, perWorkspaceKeep: null }, false)
    expect(result.failed).toEqual([{ sessionId: 'w2-only', error: 'boom' }])
    expect(result.archived).not.toContain('w2-only')
    expect(result.archived).toContain('fresh')
  })

  it('respects the enabled flag end to end', async () => {
    const { host, archivedCalls } = makeHost()
    const result = await runAutoArchive(host, { enabled: false, maxIdleDays: 1, perWorkspaceKeep: null }, false)
    expect(result.selected).toEqual([])
    expect(archivedCalls).toEqual([])
  })
})

describe('saveRules creates the home directory when missing', () => {
  it('writes into a fresh nested home', async () => {
    const home = join(tempHome(), 'nested', 'deeper')
    await saveRules({ enabled: true, maxIdleDays: 2, perWorkspaceKeep: null }, home)
    expect(await loadRules(home)).toEqual({ enabled: true, maxIdleDays: 2, perWorkspaceKeep: null })
    mkdirSync(home, { recursive: true }) // no-op assertion: dirs were created by saveRules
  })
})
