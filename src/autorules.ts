/** Auto-archive: rule storage, a pure selection engine, and the executor.
 *
 * Archiving itself goes through the registry's PUBLIC `archiveSession` —
 * no private surface is involved in this half. The engine is a pure function
 * over resolved inputs (activity map, workspace accounting, archive set) so
 * the policy is exhaustively unit-testable; only the activity resolution
 * (persistence `inspect` — parses the session log for the last event time)
 * touches I/O, with `createdAt` as the fallback oracle. */

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { inspectionHeaderOf, inspectionLogOf } from './archive.ts'
import type { AutoCandidate, AutoRules, ArchiveHost, PersistenceLike, WorkspaceLike } from './types.ts'

/** Defaults: the whole feature is opt-in. */
export const DEFAULT_RULES: AutoRules = { enabled: false, maxIdleDays: 30, perWorkspaceKeep: null }

/** day in ms. */
const DAY_MS = 86_400_000

/** The plugin's settings file lives next to the profile data, under DSH_HOME. */
export function settingsPath(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  return join(dshHome, 'dsh-plugin-archive-manager.json')
}

/** Pre-rename location (this plugin was dsh-plugin-atlas until 0.3.0):
 * consulted read-only so a rename never silently resets a user's rules. */
function legacySettingsPath(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  return join(dshHome, 'dsh-plugin-atlas.json')
}

/** Load persisted rules; any read/shape fault degrades to defaults (the
 * feature stays off — a corrupt settings file must never archive things).
 * Falls back to the pre-rename settings file when the new one is absent. */
export async function loadRules(dshHome?: string): Promise<AutoRules> {
  for (const path of [settingsPath(dshHome), legacySettingsPath(dshHome)]) {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
      const validated = validateRules(raw)
      if (validated !== null) return validated
    } catch {
      // absent or unreadable — try the next candidate
    }
  }
  return DEFAULT_RULES
}

/** Persist rules; the write is atomic-enough for a single-object config
 * (write then rename-free — a torn tail degrades to defaults on next load). */
export async function saveRules(rules: AutoRules, dshHome?: string): Promise<void> {
  const path = settingsPath(dshHome)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(rules, null, 2) + '\n', 'utf8')
}

const isIntIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/** Validate an untrusted rules object; returns null when malformed. */
export function validateRules(input: unknown): AutoRules | null {
  if (input === null || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (typeof raw.enabled !== 'boolean') return null
  const idle = raw.maxIdleDays
  const keep = raw.perWorkspaceKeep
  if (idle !== null && !isIntIn(idle, 1, 3650)) return null
  if (keep !== null && !isIntIn(keep, 1, 500)) return null
  return { enabled: raw.enabled, maxIdleDays: idle, perWorkspaceKeep: keep }
}

/** Selection inputs with every I/O already resolved. */
export interface SelectionInput {
  readonly workspaces: readonly WorkspaceLike[]
  readonly archived: readonly string[]
  readonly live: readonly string[]
  /** Resolved last-activity ms per candidate session (missing → 0 = oldest). */
  readonly activityById: ReadonlyMap<string, number>
  readonly rules: AutoRules
  readonly now: number
}

/**
 * Pure policy: which visible (accounted, non-archived, non-live) sessions do
 * the rules archive? `perWorkspaceKeep` keeps the N most-recently-active
 * sessions of each workspace and archives the overflow; `maxIdleDays`
 * archives anything whose last activity is older than the threshold. A
 * session caught by both is labeled 'idle'.
 */
export function selectAutoArchive(input: SelectionInput): AutoCandidate[] {
  if (!input.rules.enabled) return []
  if (input.rules.maxIdleDays === null && input.rules.perWorkspaceKeep === null) return []
  const archived = new Set(input.archived)
  const live = new Set(input.live)
  const idleBefore = input.rules.maxIdleDays === null
    ? null
    : input.now - input.rules.maxIdleDays * DAY_MS

  const chosen = new Map<string, AutoCandidate>()
  for (const workspace of input.workspaces) {
    const visible = workspace.sessionIds.filter(id => !archived.has(id) && !live.has(id))
    if (idleBefore !== null) {
      for (const id of visible) {
        const activity = input.activityById.get(id) ?? 0
        if (activity < idleBefore) {
          chosen.set(id, { sessionId: id, workspaceId: workspace.id, reason: 'idle', lastActivityMs: activity })
        }
      }
    }
    if (input.rules.perWorkspaceKeep !== null) {
      const ordered = [...visible].sort((a, b) =>
        (input.activityById.get(b) ?? 0) - (input.activityById.get(a) ?? 0) || a.localeCompare(b))
      for (const id of ordered.slice(input.rules.perWorkspaceKeep)) {
        chosen.set(id, {
          sessionId: id,
          workspaceId: workspace.id,
          reason: chosen.has(id) ? 'idle' : 'overflow',
          lastActivityMs: input.activityById.get(id) ?? 0,
        })
      }
    }
  }
  return [...chosen.values()]
}

/** Last activity of one session: the newest persisted event time, falling
 * back to the header's createdAt when the log cannot be inspected. */
export async function resolveActivity(persistence: PersistenceLike, sessionId: string): Promise<number> {
  try {
    const inspection = await persistence.inspect(sessionId)
    let last = inspectionHeaderOf(inspection)?.createdAt ?? 0
    for (const event of inspectionLogOf(inspection)) {
      if (event.time > last) last = event.time
    }
    return last
  } catch {
    return 0
  }
}

/** Executor outcome for the manual route and the scheduler. */
export interface AutoRunResult {
  readonly dryRun: boolean
  readonly selected: AutoCandidate[]
  readonly archived: string[]
  readonly failed: { sessionId: string; error: string }[]
}

/** Resolve activity for every visible candidate, run the policy, then (unless
 * dry-run) archive through the registry's public API. Per-session archive
 * failures are collected, never aborting the batch. */
export async function runAutoArchive(host: ArchiveHost, rules: AutoRules, dryRun: boolean): Promise<AutoRunResult> {
  const registry = host.workspaceRegistry
  const workspaces = registry.list()
  const archived = registry.archivedSessionIds
  const liveIds = host.sessions === undefined ? [] : workspaces
    .flatMap(workspace => workspace.sessionIds)
    .filter(id => host.sessions?.get(id) !== undefined)

  const visible = workspaces
    .flatMap(workspace => workspace.sessionIds.filter(id => !archived.includes(id) && !liveIds.includes(id)))
  const activityById = new Map<string, number>()
  for (const id of visible) activityById.set(id, await resolveActivity(host.sessionPersistence, id))

  const selected = selectAutoArchive({
    workspaces, archived, live: liveIds, activityById, rules, now: Date.now(),
  })
  if (dryRun || selected.length === 0) {
    return { dryRun, selected, archived: [], failed: [] }
  }

  const archivedNow: string[] = []
  const failed: { sessionId: string; error: string }[] = []
  for (const candidate of selected) {
    try {
      await registry.archiveSession(candidate.sessionId)
      archivedNow.push(candidate.sessionId)
    } catch (error) {
      failed.push({ sessionId: candidate.sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { dryRun: false, selected, archived: archivedNow, failed }
}
