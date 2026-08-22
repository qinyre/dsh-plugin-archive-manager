/** HTTP routes bridging the archive drawer / rail settings to the host.
 * This layer parses requests, validates payloads, calls the service modules,
 * and serializes responses — policy lives in archive.ts / autorules.ts. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sameOrigin, sendJson } from './http.ts'
import { buildArchiveRows, buildPreview, unarchiveIds, UnarchiveUnsupportedError } from './archive.ts'
import { loadRules, runAutoArchive, saveRules, validateRules } from './autorules.ts'
import { railTicksOfLog } from './rail-index.ts'
import type { AtlasHost, AutoRules } from './types.ts'

/** Session ids are opaque strings; bound shape to keep payloads tame. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
/** Batch upper bound — one per visible row is plenty. */
const MAX_BATCH = 500

export interface AtlasRouteOptions {
  /** Where persisted rules live (tests inject a temp dir). */
  dshHome?: string
  /** Called after rules change so the scheduler can re-arm. */
  onRulesChanged?: (rules: AutoRules) => void
}

function replyError(response: ServerResponse, status: number, error: string): void {
  sendJson(response, status, { error })
}

/** Register every /dsh-plugin-atlas route.
 * @returns a disposer removing them all. */
export function mountAtlasRoutes(host: AtlasHost, options: AtlasRouteOptions = {}): () => void {
  /** Serialized writer fence: one unarchive/rules write at a time. */
  let writing = false

  const withWriteFence = async (
    request: IncomingMessage,
    response: ServerResponse,
    action: () => Promise<void>,
  ): Promise<void> => {
    if (!sameOrigin(request)) {
      replyError(response, 403, 'untrusted origin')
      return
    }
    if (writing) {
      replyError(response, 409, 'another write is already running')
      return
    }
    writing = true
    try {
      await action()
    } finally {
      writing = false
    }
  }

  const disposers = [
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-atlas/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
        const rules = await loadRules(options.dshHome)
        sendJson(response, 200, {
          ok: true,
          name: 'dsh-plugin-atlas',
          unarchiveSupported: typeof host.workspaceRegistry.setState === 'function',
          archivedCount: host.workspaceRegistry.archivedSessionIds.length,
          rules,
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-atlas/list',
      handler: async (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
        try {
          const [headers, workspaces] = await Promise.all([
            host.sessionPersistence.list().catch(() => []),
            Promise.resolve(host.workspaceRegistry.list()),
          ])
          sendJson(response, 200, {
            rows: buildArchiveRows(host.workspaceRegistry.archivedSessionIds, headers, workspaces),
          })
        } catch (error) {
          replyError(response, 500, error instanceof Error ? error.message : String(error))
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-atlas/preview',
      handler: async (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
        const id = new URL(request.url ?? '/', 'http://dsh').searchParams.get('sessionId') ?? ''
        if (!SESSION_ID_RE.test(id)) { replyError(response, 400, 'invalid sessionId'); return }
        if (!host.workspaceRegistry.archivedSessionIds.includes(id)) {
          replyError(response, 404, 'session is not archived')
          return
        }
        sendJson(response, 200, await buildPreview(host.sessionPersistence, id))
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-atlas/rail',
      handler: async (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return }
        const id = new URL(request.url ?? '/', 'http://dsh').searchParams.get('sessionId') ?? ''
        if (!SESSION_ID_RE.test(id)) { replyError(response, 400, 'invalid sessionId'); return }
        try {
          const inspection = await host.sessionPersistence.inspect(id)
          sendJson(response, 200, { ticks: railTicksOfLog(inspection.log) })
        } catch (error) {
          replyError(response, 500, error instanceof Error ? error.message : String(error))
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-atlas/unarchive',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        await withWriteFence(request, response, async () => {
          try {
            const body = (await readJsonBody(request)) as { sessionId?: unknown }
            const id = typeof body.sessionId === 'string' ? body.sessionId : ''
            if (!SESSION_ID_RE.test(id)) { replyError(response, 400, 'invalid sessionId'); return }
            sendJson(response, 200, { ok: true, archivedSessionIds: await unarchiveIds(host.workspaceRegistry, [id]) })
          } catch (error) {
            if (error instanceof UnarchiveUnsupportedError) { replyError(response, 503, error.message); return }
            replyError(response, 500, error instanceof Error ? error.message : String(error))
          }
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-atlas/unarchive-batch',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        await withWriteFence(request, response, async () => {
          try {
            const body = (await readJsonBody(request)) as { sessionIds?: unknown }
            const ids = Array.isArray(body.sessionIds)
              ? body.sessionIds.filter((id): id is string => typeof id === 'string' && SESSION_ID_RE.test(id))
              : []
            if (ids.length === 0) { replyError(response, 400, 'no valid sessionIds'); return }
            if (ids.length > MAX_BATCH) { replyError(response, 400, `too many sessionIds (max ${MAX_BATCH})`); return }
            sendJson(response, 200, { ok: true, archivedSessionIds: await unarchiveIds(host.workspaceRegistry, ids) })
          } catch (error) {
            if (error instanceof UnarchiveUnsupportedError) { replyError(response, 503, error.message); return }
            replyError(response, 500, error instanceof Error ? error.message : String(error))
          }
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-atlas/rules',
      handler: async (request, response) => {
        if (request.method === 'GET') {
          sendJson(response, 200, { rules: await loadRules(options.dshHome) })
          return
        }
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'GET, POST' }); response.end(); return }
        await withWriteFence(request, response, async () => {
          try {
            const body = (await readJsonBody(request)) as { rules?: unknown }
            const rules = validateRules(body.rules)
            if (rules === null) { replyError(response, 400, 'invalid rules'); return }
            await saveRules(rules, options.dshHome)
            options.onRulesChanged?.(rules)
            sendJson(response, 200, { ok: true, rules })
          } catch (error) {
            replyError(response, 500, error instanceof Error ? error.message : String(error))
          }
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-plugin-atlas/autorun',
      handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end(); return }
        await withWriteFence(request, response, async () => {
          try {
            const body = (await readJsonBody(request)) as { dryRun?: unknown }
            const rules = await loadRules(options.dshHome)
            const result = await runAutoArchive(host, rules, body.dryRun !== false)
            sendJson(response, 200, result)
          } catch (error) {
            replyError(response, 500, error instanceof Error ? error.message : String(error))
          }
        })
      },
    }),
  ]

  return () => { for (const dispose of disposers) dispose() }
}
