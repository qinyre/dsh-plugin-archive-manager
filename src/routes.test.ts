/** Route-level tests over a capturing fake webServer: method gating, CSRF
 * fence, payload validation, and the happy paths against in-memory fakes.
 * Rules persistence is pointed at a temp home so tests never touch the real
 * DSH_HOME. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountAtlasRoutes } from './routes.ts'
import type { AtlasHost, AutoRules } from './types.ts'

interface Captured {
  status: number
  headers: Record<string, string>
  body: string
  json<T = unknown>(): T
}

const makeResponse = (): { writeHead(status: number, headers: Record<string, string>): void; end(chunk?: string): void; last(): Captured } => {
  const writes: Captured[] = []
  return {
    writeHead(status, headers) {
      writes.push({ status, headers, body: '', json<T>() { return JSON.parse((writes[writes.length - 1] as Captured).body) as T } })
    },
    end(chunk) {
      const last = writes[writes.length - 1]
      if (last !== undefined && chunk !== undefined) last.body += chunk
    },
    last: () => writes[writes.length - 1] as Captured,
  }
}

type FakeRequest = PassThrough & {
  method: string
  url: string
  headers: Record<string, string | undefined>
}

const request = (
  method: string,
  path: string,
  options: { origin?: string; host?: string; body?: string } = {},
): FakeRequest => {
  const stream = new PassThrough() as FakeRequest
  stream.method = method
  stream.url = path
  stream.headers = { origin: options.origin, host: options.host ?? 'dsh.local' }
  stream.end(options.body ?? '')
  return stream
}

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  handler(path: string): (req: FakeRequest, res: ReturnType<typeof makeResponse>) => Promise<void> | void
  registry: {
    archivedSessionIds: string[]
    state: { archivedSessionIds: string[] } & Record<string, unknown>
    setState: ReturnType<typeof vi.fn>
    archiveSession: ReturnType<typeof vi.fn>
    list: () => unknown[]
  }
  persistence: { list: () => Promise<unknown[]>; inspect: ReturnType<typeof vi.fn> }
  rulesChanged: ReturnType<typeof vi.fn>
  home: string
}

const makeFixture = (): Fixture => {
  const home = mkdtempSync(join(tmpdir(), 'atlas-routes-'))
  tempRoots.push(home)

  const registry = {
    archivedSessionIds: ['s1', 's2'],
    state: { initialized: true, archivedSessionIds: ['s1', 's2'] },
    setState: vi.fn(async (next: Record<string, unknown>) => {
      registry.state = next as typeof registry.state
      registry.archivedSessionIds = (next as { archivedSessionIds: string[] }).archivedSessionIds
    }),
    archiveSession: vi.fn(),
    list: () => [{ id: 'w1', title: 'Proj', path: '/p', sessionIds: ['s2'] }],
  }
  const persistence = {
    list: async () => [{ id: 's1', createdAt: 10, cwd: '/p' }, { id: 's2', createdAt: 20, cwd: '/p' }],
    inspect: vi.fn(async (id: string) => ({
      header: { id, createdAt: 10 },
      log: [{ type: 'user/message', seq: 1, time: 99, data: { content: [{ type: 'text', text: `hello ${id}` }] } }],
    })),
  }
  const rulesChanged = vi.fn()

  const capturing: { path: string; handler: (req: FakeRequest, res: ReturnType<typeof makeResponse>) => Promise<void> | void }[] = []
  const host: AtlasHost = {
    webServer: { register: route => { capturing.push(route as unknown as typeof capturing[number]); return () => undefined } },
    workspaceRegistry: registry,
    sessionPersistence: persistence,
  }
  mountAtlasRoutes(host, { dshHome: home, onRulesChanged: rulesChanged })

  return {
    handler: path => capturing.find(route => route.path === path)?.handler ?? (() => { throw new Error(`no route ${path}`) }),
    registry,
    persistence,
    rulesChanged,
    home,
  }
}

describe('atlas routes', () => {
  it('status reports capabilities and rules', async () => {
    const fixture = makeFixture()
    const res = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/status')(request('GET', '/dsh-plugin-atlas/status'), res)
    const body = res.last().json<{ ok: boolean; unarchiveSupported: boolean; archivedCount: number; rules: { enabled: boolean } }>()
    expect(res.last().status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.unarchiveSupported).toBe(true)
    expect(body.archivedCount).toBe(2)
    expect(body.rules.enabled).toBe(false)
  })

  it('list joins rows with workspace accounting', async () => {
    const fixture = makeFixture()
    const res = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/list')(request('GET', '/dsh-plugin-atlas/list'), res)
    const body = res.last().json<{ rows: { id: string; workspaceTitle: string | null }[] }>()
    expect(body.rows.map(row => row.id)).toEqual(['s1', 's2'])
    expect(body.rows[1]?.workspaceTitle).toBe('Proj')
  })

  it('preview serves only archived sessions', async () => {
    const fixture = makeFixture()
    const ok = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/preview')(request('GET', '/dsh-plugin-atlas/preview?sessionId=s1'), ok)
    expect(ok.last().status).toBe(200)
    expect(ok.last().json<{ title: string }>().title).toBe('hello s1')

    const missing = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/preview')(request('GET', '/dsh-plugin-atlas/preview?sessionId=never'), missing)
    expect(missing.last().status).toBe(404)
  })

  it('rail serves the tick index for any persisted session, archived or not', async () => {
    const fixture = makeFixture()
    fixture.persistence.inspect.mockImplementation(async (id: string) => ({
      header: { id, createdAt: 10 },
      log: [
        { type: 'user/message', seq: 1, time: 111, surfaceOp: 'append', data: { id: 'm1', content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } } },
        { type: 'assistant/message', seq: 2, time: 112, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'text', text: 'answer' }] } } },
      ],
    }))
    const res = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/rail')(request('GET', '/dsh-plugin-atlas/rail?sessionId=s1'), res)
    expect(res.last().status).toBe(200)
    expect(res.last().json<{ ticks: { key: string; reply: string }[] }>().ticks).toEqual([
      { key: '13:input-messagem1', text: 'question', time: 111, reply: 'answer' },
    ])
  })

  it('rail answers 400 on a malformed id and 500 when the log is unreadable', async () => {
    const fixture = makeFixture()
    const bad = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/rail')(request('GET', '/dsh-plugin-atlas/rail?sessionId=..%2Fetc'), bad)
    expect(bad.last().status).toBe(400)

    fixture.persistence.inspect.mockRejectedValueOnce(new Error('log gone'))
    const dead = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/rail')(request('GET', '/dsh-plugin-atlas/rail?sessionId=s1'), dead)
    expect(dead.last().status).toBe(500)
    expect(dead.last().json<{ error: string }>().error).toBe('log gone')
  })

  it('rail folds the current-build {meta, events} inspection shape too', async () => {
    const fixture = makeFixture()
    fixture.persistence.inspect.mockResolvedValueOnce({
      meta: { id: 's1', createdAt: 10 },
      events: [
        { type: 'user/message', seq: 1, time: 111, surfaceOp: 'append', data: { id: 'm1', content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } } },
      ],
    })
    const res = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/rail')(request('GET', '/dsh-plugin-atlas/rail?sessionId=s1'), res)
    expect(res.last().status).toBe(200)
    expect(res.last().json<{ ticks: { key: string }[] }>().ticks).toEqual([{ key: '13:input-messagem1', text: 'question', time: 111, reply: '' }])
  })

  it('unarchive-batch removes ids behind the CSRF fence', async () => {
    const fixture = makeFixture()

    const blocked = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/unarchive-batch')(
      request('POST', '/dsh-plugin-atlas/unarchive-batch', { origin: 'http://evil', body: '{"sessionIds":["s1"]}' }), blocked)
    expect(blocked.last().status).toBe(403)

    const badPayload = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/unarchive-batch')(
      request('POST', '/dsh-plugin-atlas/unarchive-batch', { origin: 'http://dsh.local', body: '{"sessionIds":[]}' }), badPayload)
    expect(badPayload.last().status).toBe(400)

    const ok = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/unarchive-batch')(
      request('POST', '/dsh-plugin-atlas/unarchive-batch', { origin: 'http://dsh.local', body: '{"sessionIds":["s1","s2"]}' }), ok)
    expect(ok.last().status).toBe(200)
    expect(ok.last().json<{ ok: boolean; archivedSessionIds: string[] }>().archivedSessionIds).toEqual([])
    expect(fixture.registry.archivedSessionIds).toEqual([])
  })

  it('rules POST validates, persists to the temp home, and notifies', async () => {
    const fixture = makeFixture()

    const invalid = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/rules')(
      request('POST', '/dsh-plugin-atlas/rules', { origin: 'http://dsh.local', body: '{"rules":{"enabled":true,"maxIdleDays":-5}}' }), invalid)
    expect(invalid.last().status).toBe(400)
    expect(fixture.rulesChanged).not.toHaveBeenCalled()

    const valid = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/rules')(
      request('POST', '/dsh-plugin-atlas/rules', {
        origin: 'http://dsh.local',
        body: '{"rules":{"enabled":true,"maxIdleDays":7,"perWorkspaceKeep":null}}',
      }), valid)
    expect(valid.last().status).toBe(200)
    expect(fixture.rulesChanged).toHaveBeenCalledWith({ enabled: true, maxIdleDays: 7, perWorkspaceKeep: null } satisfies AutoRules)

    const readBack = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/rules')(request('GET', '/dsh-plugin-atlas/rules'), readBack)
    expect(readBack.last().json<{ rules: AutoRules }>().rules).toEqual({ enabled: true, maxIdleDays: 7, perWorkspaceKeep: null })
  })

  it('autorun honors dry-run default and returns policy output', async () => {
    const fixture = makeFixture()
    const res = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/autorun')(
      request('POST', '/dsh-plugin-atlas/autorun', { origin: 'http://dsh.local', body: '{"dryRun":true}' }), res)
    const body = res.last().json<{ dryRun: boolean; selected: unknown[]; archived: string[] }>()
    expect(res.last().status).toBe(200)
    expect(body.dryRun).toBe(true)
    expect(body.archived).toEqual([])
  })

  it('method gating answers 405', async () => {
    const fixture = makeFixture()
    const res = makeResponse()
    await fixture.handler('/dsh-plugin-atlas/list')(request('POST', '/dsh-plugin-atlas/list', { origin: 'http://dsh.local', body: '{}' }), res)
    expect(res.last().status).toBe(405)
  })
})
