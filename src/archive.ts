/** Archive-manager core: list rows, lazy preview, and the unarchive funnel.
 *
 * The core RPC surface offers `workspace.archiveSession` but no inverse; the
 * data model deliberately preserves the archived session's workspace slot
 * ("a future unarchive restores its position"). This module implements that
 * inverse through the registry's own state-write funnel: one durable write
 * that the api-proxy relays to every connected client, so the session
 * reappears in the sidebar live, without a restart. */

import type {
  ArchivePreview, ArchiveRow, EventLike, HeaderLike, PersistenceLike, SessionInspectionLike,
  RegistryWriteSurface, WorkspaceLike,
} from './types.ts'

/** Character cap for preview/title extraction. */
export const PREVIEW_CHARS = 200

/** The event log of an inspection result, whichever field pair carries it
 * (current dsh builds say `events`, the plugin's original guess said `log`). */
export function inspectionLogOf(inspection: SessionInspectionLike): readonly EventLike[] {
  if (Array.isArray(inspection.events)) return inspection.events
  if (Array.isArray(inspection.log)) return inspection.log
  return []
}

/** The header of an inspection result, whichever field pair carries it. */
export function inspectionHeaderOf(inspection: SessionInspectionLike): HeaderLike | undefined {
  return inspection.meta ?? inspection.header
}

/** Extract readable text from a user-message event payload, defensively:
 * the wire shape (`content` block list) plus plain-string variants. */
export function textOfUserMessage(data: unknown): string {
  if (typeof data === 'string') return data
  if (data === null || typeof data !== 'object') return ''
  const content = (data as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { type?: unknown; text?: unknown }).text
    if (typeof text === 'string') out += text
  }
  return out.trim()
}

/** Fold a persisted log into the preview facts the drawer shows. The title
 * prefers the log's accepted `session/title` event — the same durable name
 * the sidebar shows, stable across renames — and falls back to the first
 * user message (often pasted code, which read as gibberish as a row name)
 * only for sessions that never earned one. */
export function previewOfLog(events: readonly EventLike[]): Omit<ArchivePreview, 'id'> {
  let title: string | null = null
  let lastUser: string | null = null
  let turns = 0
  let lastActivityMs: number | null = null
  for (const event of events) {
    if (event.type === 'session/title') {
      const accepted = (event.data as { title?: unknown } | null)?.title
      if (typeof accepted === 'string' && accepted.trim() !== '') title = accepted.slice(0, PREVIEW_CHARS)
    } else if (event.type === 'user/message') {
      const text = textOfUserMessage(event.data)
      if (text !== '') {
        if (title === null) title = text.slice(0, PREVIEW_CHARS)
        lastUser = text.slice(0, PREVIEW_CHARS)
      }
    } else if (event.type === 'turn/end') {
      turns += 1
    }
    lastActivityMs = event.time
  }
  return { title, lastUser, turns, lastActivityMs }
}

/** Build archive-manager rows: archived ids × headers × workspace accounting. */
export function buildArchiveRows(
  archivedIds: readonly string[],
  headers: readonly HeaderLike[],
  workspaces: readonly WorkspaceLike[],
): ArchiveRow[] {
  const byId = new Map(headers.map(header => [header.id, header]))
  const ownerOf = new Map<string, WorkspaceLike>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) ownerOf.set(sessionId, workspace)
  }
  return archivedIds.map(id => {
    const header = byId.get(id)
    const workspace = ownerOf.get(id)
    return {
      id,
      createdAt: header?.createdAt ?? 0,
      cwd: header?.cwd ?? null,
      workspaceId: workspace?.id ?? null,
      workspaceTitle: workspace?.title ?? null,
    }
  })
}

/** Thrown when the running dsh build no longer exposes the registry write
 * funnel (it is a private-but-stable surface; a core refactor could move
 * it). The message tells the user what to do. */
export class UnarchiveUnsupportedError extends Error {
  constructor() {
    super('this dsh build exposes no workspace-registry state writer; unarchive is unsupported — update dsh and dsh-plugin-atlas together')
    this.name = 'UnarchiveUnsupportedError'
  }
}

/**
 * Remove ids from the registry-global archive set through the registry's own
 * write path — the same funnel `archiveSession` uses, so the durable state,
 * the in-memory cache, and the `domain/changed` emission (relayed by
 * api-proxy to every client) all observe one coherent transition.
 * @returns the resulting archive set (ids that were never archived are a
 * no-op).
 */
export async function unarchiveIds(
  registry: RegistryWriteSurface,
  ids: readonly string[],
): Promise<readonly string[]> {
  const state = registry.state
  if (state === undefined) throw new Error('workspace registry is not started yet')
  if (typeof registry.setState !== 'function') throw new UnarchiveUnsupportedError()
  const drop = new Set(ids)
  const current = state.archivedSessionIds
  const next = current.filter(id => !drop.has(id))
  if (next.length === current.length) return next
  await registry.setState({ ...state, archivedSessionIds: next })
  return next
}

/** Lazy preview for one archived session; a failing inspect degrades to
 * header-only facts rather than failing the route. */
export async function buildPreview(
  persistence: PersistenceLike,
  sessionId: string,
): Promise<ArchivePreview> {
  try {
    const inspection = await persistence.inspect(sessionId)
    return { id: sessionId, ...previewOfLog(inspectionLogOf(inspection)) }
  } catch {
    return { id: sessionId, title: null, lastUser: null, turns: 0, lastActivityMs: null }
  }
}
