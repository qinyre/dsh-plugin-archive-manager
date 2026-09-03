/** Shared structural types across the archive-manager host modules.
 *
 * Everything the plugin touches on the host side is described as a minimal
 * structural interface: the real services (workspaceRegistry,
 * sessionPersistence, sessions, webServer) satisfy them, and tests provide
 * fakes. Nothing imports dsh packages at runtime on the host side — the
 * registry write path is deliberately accessed through the structural cast
 * (see archive.ts for why and its version guard). */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Minimal persisted-session header the archive list consumes. */
export interface HeaderLike {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
}

/** One event of a persisted session log (only the fields we read). */
export interface EventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  /** Surface marker on message-producing events: 'append' or a replace op.
   * Archive previews only fold append-origin rows (the human transcript). */
  readonly surfaceOp?: unknown
}

/**
 * What `sessionPersistence.inspect` resolves to. Current dsh builds return
 * `{ meta, events }`; the plugin originally guessed `{ header, log }` — a
 * shape the real service never had, which made every preview degrade to the
 * header-only fallback (rows rendered raw session ids). Both field pairs are
 * accepted; `inspectionLogOf`/`inspectionHeaderOf` normalize.
 */
export interface SessionInspectionLike {
  readonly meta?: HeaderLike
  readonly header?: HeaderLike
  readonly events?: readonly EventLike[]
  readonly log?: readonly EventLike[]
}

/** sessionPersistence structural subset. */
export interface PersistenceLike {
  list(signal?: AbortSignal): Promise<HeaderLike[]>
  inspect(id: string, signal?: AbortSignal): Promise<SessionInspectionLike>
}

/** One workspace row as the archive list sees it. */
export interface WorkspaceLike {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/**
 * The workspace registry's private-but-stable write surface. `state` and
 * `setState` are TypeScript-private on the real class, not JS-private — the
 * competitor-proven unarchive path funnels through the very same writer
 * `archiveSession` uses, so the durable state, the in-memory cache, and the
 * `domain/changed` emission (which api-proxy relays to every connected
 * client as `host/archived-sessions-changed`) all stay coherent.
 */
export interface RegistryWriteSurface {
  readonly archivedSessionIds: readonly string[]
  readonly state?: { archivedSessionIds: readonly string[] } & Record<string, unknown>
  setState?(state: Record<string, unknown>): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  list(): WorkspaceLike[]
}

/** Live session store structural subset. */
export interface SessionsLike {
  get(id: string): unknown
}

/** The webServer service subset this plugin consumes. */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The host surface the archive manager needs. */
export interface ArchiveHost {
  webServer: WebServerService
  workspaceRegistry: RegistryWriteSurface
  sessionPersistence: PersistenceLike
  sessions?: SessionsLike
  logger?: { warn(message: string): void; info(message: string): void }
}

/** One archive-manager row. */
export interface ArchiveRow {
  readonly id: string
  readonly createdAt: number
  readonly cwd: string | null
  readonly workspaceId: string | null
  readonly workspaceTitle: string | null
}

/** Lazily-fetched preview of one archived session. */
export interface ArchivePreview {
  readonly id: string
  /** First user message, truncated — the de-facto title. */
  readonly title: string | null
  /** Last user message, truncated. */
  readonly lastUser: string | null
  /** Completed turn count. */
  readonly turns: number
  /** Last event time (Unix epoch ms). */
  readonly lastActivityMs: number | null
}

/** Auto-archive rules, persisted under DSH_HOME. Default OFF. */
export interface AutoRules {
  readonly enabled: boolean
  /** Archive sessions idle for more than this many days; null = rule off. */
  readonly maxIdleDays: number | null
  /** Keep at most this many sessions per workspace (newest-activity first); null = rule off. */
  readonly perWorkspaceKeep: number | null
}

/** One candidate the auto-rule engine decided to archive. */
export interface AutoCandidate {
  readonly sessionId: string
  readonly workspaceId: string | null
  /** Why this candidate was selected: 'idle' | 'overflow'. */
  readonly reason: 'idle' | 'overflow'
  readonly lastActivityMs: number | null
}
