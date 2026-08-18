/** dsh-plugin-atlas client entry: the sidebar-foot archive drawer, the
 * conversation tick rail, and their shared locale + CSS. The rail and the
 * drawer talk to the host half through same-origin fetch on
 * /dsh-plugin-atlas/* (registered by src/routes.ts). */

import { createElement, useSyncExternalStore } from 'react'
import { Rail } from './rail.tsx'
import { ArchivePanel, type AtlasApi } from './ArchivePanel.tsx'
import { zh, en } from './locales.ts'

/** Locale dictionary namespace owned by this plugin. */
export const NS = 'atlas'

/** The `t` function bound by the locale service. */
export interface Translate {
  (key: string): string
}

/** Minimal structural subsets of the client services (same style as
 * dsh-plugin-install's client entry — structural, not imported). */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: (props: never) => unknown): unknown
}
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}
/** A bound live session (the runtime's binding target). */
interface BoundSession {
  getSnapshot(): unknown
  loadOlder(): Promise<unknown>
}
interface SessionsService {
  binding(sessionId: string): { session?: BoundSession } | undefined
}

interface AtlasClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sessions: SessionsService
}

// ---------------------------------------------------------------------------
// Same-origin host API

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

const postJson = <T>(path: string, body: unknown): Promise<T> =>
  fetchJson<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function makeApi(): AtlasApi {
  return {
    list: () => fetchJson<{ rows: import('../types.ts').ArchiveRow[] }>('/dsh-plugin-atlas/list'),
    preview: (sessionId: string) => fetchJson<import('../types.ts').ArchivePreview>(
      `/dsh-plugin-atlas/preview?sessionId=${encodeURIComponent(sessionId)}`),
    unarchiveBatch: (sessionIds: string[]) =>
      postJson<{ archivedSessionIds: string[] }>('/dsh-plugin-atlas/unarchive-batch', { sessionIds }),
    rules: () => fetchJson<{ rules: import('../types.ts').AutoRules }>('/dsh-plugin-atlas/rules'),
    saveRules: (rules: import('../types.ts').AutoRules) =>
      postJson<{ rules: import('../types.ts').AutoRules }>('/dsh-plugin-atlas/rules', { rules }),
    autorun: (dryRun: boolean) =>
      postJson<{ archived: string[]; selected: unknown[] }>('/dsh-plugin-atlas/autorun', { dryRun }),
  }
}

// ---------------------------------------------------------------------------
// Drawer open state (shared between the sidebar-foot button and the overlay)

let drawerOpen = false
const drawerListeners = new Set<() => void>()
function setDrawerOpen(open: boolean): void {
  if (drawerOpen === open) return
  drawerOpen = open
  for (const listener of drawerListeners) listener()
}
function useDrawerOpen(): boolean {
  return useSyncExternalStore(
    listener => {
      drawerListeners.add(listener)
      return () => { drawerListeners.delete(listener) }
    },
    () => drawerOpen,
    () => false,
  )
}

// ---------------------------------------------------------------------------
// Jump / loadAll factories (session-scoped, robust against pagination and
// async DOM commits — the same battle-tested shape the market rails use)

const JUMP_LOOP_CAP = 120
const DOM_POLL_ATTEMPTS = 20
const DOM_POLL_DELAY = 50
const RETRY_BACKOFF_MS = 200
const LOADING_WAIT_MS = 50
const LOAD_MAX_PAGES = 400
const LOAD_MAX_STALLS = 5
const FLASH_MS = 1400

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

interface ChatSnapshot {
  chat?: { order?: string[]; nodes?: Map<string, unknown> }
  hasMore?: boolean
  loadingOlder?: boolean
}

function snapshotOf(service: SessionsService, sessionId: string): { session?: BoundSession } {
  return service.binding(sessionId) ?? {}
}

function findRow(key: string): HTMLElement | null {
  for (const row of Array.from(document.querySelectorAll('[data-chat-anchor-key]'))) {
    if ((row as HTMLElement).dataset.chatAnchorKey === key) return row as HTMLElement
  }
  return null
}

/** Jump to one chat row; loads older pages until the target exists, then
 * scrolls (respecting reduced motion) and flashes the row. */
function createJump(service: SessionsService, sessionId: string): (key: string) => Promise<boolean> {
  return async key => {
    const { session } = snapshotOf(service, sessionId)
    if (session === undefined) return false
    let guard = 0
    let stalls = 0
    while (guard++ < JUMP_LOOP_CAP) {
      const snapshot = session.getSnapshot() as ChatSnapshot | undefined
      if (snapshot?.chat?.nodes?.get(key) !== undefined) break
      if (snapshot === undefined || snapshot.hasMore !== true) return false
      if (snapshot.loadingOlder === true) { await delay(LOADING_WAIT_MS); continue }
      const before = snapshot.chat?.order?.length ?? 0
      try { await session.loadOlder() } catch { await delay(RETRY_BACKOFF_MS) }
      const after = session.getSnapshot() as ChatSnapshot | undefined
      if ((after?.chat?.order?.length ?? before) === before) {
        stalls += 1
        if (stalls >= 5) return false
        await delay(RETRY_BACKOFF_MS)
      } else {
        stalls = 0
      }
    }
    let row: HTMLElement | null = null
    for (let attempt = 0; attempt < DOM_POLL_ATTEMPTS && row === null; attempt += 1) {
      row = findRow(key)
      if (row === null) await delay(DOM_POLL_DELAY)
    }
    if (row === null) return false
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    row.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' })
    row.classList.add('dsha-flash')
    setTimeout(() => { row?.classList.remove('dsha-flash') }, FLASH_MS)
    return true
  }
}

/** Back-fill the entire history so the rail indexes every user message. */
function createLoadAll(service: SessionsService, sessionId: string): (disposed: () => boolean) => Promise<void> {
  return async disposed => {
    const { session } = snapshotOf(service, sessionId)
    if (session === undefined) return
    let guard = 0
    let stalls = 0
    while (guard++ < LOAD_MAX_PAGES) {
      if (disposed()) return
      const snapshot = session.getSnapshot() as ChatSnapshot | undefined
      if (snapshot === undefined || snapshot.hasMore !== true) return
      if (snapshot.loadingOlder === true) { await delay(LOADING_WAIT_MS); continue }
      const before = snapshot.chat?.order?.length ?? 0
      try { await session.loadOlder() } catch { await delay(RETRY_BACKOFF_MS) }
      const after = session.getSnapshot() as ChatSnapshot | undefined
      if ((after?.chat?.order?.length ?? before) === before) {
        stalls += 1
        if (stalls >= LOAD_MAX_STALLS) return
        await delay(RETRY_BACKOFF_MS)
      } else {
        stalls = 0
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CSS

const CSS = `
.dsha-rail{position:fixed;z-index:40;pointer-events:auto}
.dsha-rail-empty{display:none}
.dsha-rail-view{position:absolute;inset:0;overflow:hidden}
.dsha-rail-col{position:absolute;left:0;right:0;top:0;display:flex;flex-direction:column}
.dsha-tick{pointer-events:auto;display:flex;align-items:center;flex:none;padding:0 0 0 2px;border:0;background:transparent;cursor:pointer}
.dsha-tick::before{content:"";display:block;width:var(--tick-w,12px);height:2px;border-radius:1px;background:var(--dsw-alias-label-dimmed,rgba(128,134,156,.75));opacity:.85;transition:width 120ms ease-out,background-color 120ms ease-out,opacity 120ms ease-out}
.dsha-tick.is-mid::before{background:var(--dsw-alias-label-tertiary,rgba(110,117,140,.85));opacity:.9}
.dsha-tick.is-near::before{background:var(--dsw-alias-label-secondary,rgba(80,88,110,.9));opacity:.95}
.dsha-tick.is-focus::before{background:var(--dsw-alias-label-primary,rgba(36,42,60,.95));opacity:1}
.dsha-railbar-thumb{position:absolute;right:1px;width:3px;border-radius:2px;background:var(--dsw-alias-label-dimmed,rgba(128,134,156,.6));opacity:.35;cursor:grab;transition:opacity .12s ease-out}
.dsha-railbar-thumb:hover,.dsha-railbar-thumb:active{opacity:.75;cursor:grabbing}
@media(prefers-reduced-motion:reduce){.dsha-tick::before,.dsha-railbar-thumb{transition:none}}
@keyframes dsha-flash{from{background-color:rgba(80,140,255,.22)}to{background-color:transparent}}
.dsha-flash{animation:dsha-flash 1.4s ease-out 1}
.dsha-preview{position:absolute;left:32px;z-index:41;width:320px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(128,134,156,.35));box-shadow:0 6px 20px rgba(0,0,0,.16);pointer-events:none}
.dsha-preview-meta{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(110,117,140,.85));margin-bottom:6px}
.dsha-preview-user{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,rgba(36,42,60,.95));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsha-preview-agent{margin-top:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,rgba(110,117,140,.9));display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsha-drawer{position:fixed;inset:0;z-index:60;pointer-events:none}
.dsha-drawer-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-2,rgba(15,18,25,.32));pointer-events:auto;animation:dsha-fade .16s ease-out}
.dsha-drawer-panel{position:absolute;top:0;right:0;bottom:0;width:min(440px,94vw);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#222);border-left:1px solid var(--dsw-alias-border-l2,rgba(128,134,156,.25));box-shadow:-12px 0 40px rgba(0,0,0,.16);pointer-events:auto;animation:dsha-slide .18s ease-out}
@keyframes dsha-fade{from{opacity:0}}
@keyframes dsha-slide{from{transform:translateX(24px);opacity:.4}}
@media(prefers-reduced-motion:reduce){.dsha-drawer-backdrop,.dsha-drawer-panel{animation:none}}
.dsha-drawer-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,134,156,.2))}
.dsha-drawer-title{font-size:15px;font-weight:600}
.dsha-drawer-count{font-size:11px;font-weight:600;color:#2e6fe8;background:rgba(46,111,232,.12);padding:1px 8px;border-radius:9px;line-height:18px}
.dsha-drawer-head-actions{margin-left:auto;display:inline-flex;gap:2px}
.dsha-drawer-btn{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:5px 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#222);cursor:pointer}
.dsha-drawer-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,134,156,.12))}
.dsha-drawer-btn:disabled{opacity:.45;cursor:default}
.dsha-drawer-btn svg{width:14px;height:14px}
.dsha-drawer-search{margin:12px 14px 4px;padding:7px 12px;font-size:13px;border:1px solid var(--dsw-alias-border-l2,rgba(128,134,156,.4));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none;transition:border-color .12s ease-out}
.dsha-drawer-search:focus{border-color:#2e6fe8}
.dsha-drawer-search::placeholder{color:var(--dsw-alias-label-secondary,rgba(80,88,110,.9))}
.dsha-drawer-body{flex:1;overflow-y:auto;padding:4px 8px 12px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(128,134,156,.4)) transparent}
.dsha-drawer-note{padding:48px 8px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,rgba(80,88,110,.9))}
.dsha-drawer-group{margin:10px 6px 4px}
.dsha-drawer-group-head{display:flex;align-items:center;justify-content:space-between;padding:2px 8px 4px}
.dsha-drawer-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222);display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-drawer-group-count{font-size:11px;font-weight:600;color:#2e6fe8;background:rgba(46,111,232,.12);border-radius:8px;padding:0 6px;line-height:16px}
.dsha-drawer-row{display:flex;gap:10px;align-items:flex-start;padding:8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.dsha-drawer-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,134,156,.12))}
.dsha-drawer-row:has(input:checked){background:rgba(46,111,232,.08);border-color:rgba(46,111,232,.35)}
.dsha-drawer-row input{margin-top:3px;accent-color:#2e6fe8}
.dsha-drawer-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsha-drawer-row-title{font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary,#222);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-drawer-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary,rgba(80,88,110,.9));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-drawer-actions{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,134,156,.2))}
.dsha-drawer-message{font-size:12px}
.dsha-drawer-message.ok{color:#2e6fe8}
.dsha-drawer-message.err{color:var(--dsw-static-red-500,#ef4444)}
.dsha-drawer-selected{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-primary,#222)}
.dsha-drawer-primary{font-size:13px;font-weight:600;padding:6px 18px;border:0;border-radius:8px;background:#2e6fe8;color:#fff;cursor:pointer}
.dsha-drawer-primary:hover:not(:disabled){background:#1f5fd8}
.dsha-drawer-primary:disabled{background:rgba(46,111,232,.14);color:#2e6fe8;cursor:default}
.dsha-rules{margin:0 14px 14px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,134,156,.4));border-radius:10px;background:var(--dsw-alias-bg-base,#fff)}
.dsha-rules-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222)}
.dsha-rules-row{display:flex;gap:8px;align-items:center;font-size:12px}
.dsha-rules-row>span{flex:1;display:flex;flex-direction:column;gap:2px}
.dsha-rules-hint{font-style:normal;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(80,88,110,.9))}
.dsha-rules-row input[type=number]{width:96px;padding:5px 8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,134,156,.4));border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none}
.dsha-rules-row input[type=number]:focus{border-color:#2e6fe8}
.dsha-rules-row input[type=checkbox]{accent-color:#2e6fe8}
.dsha-rules-actions{display:flex;gap:6px}
.dsha-rules-actions .dsha-drawer-btn{margin-left:0}
.dsha-foot-btn{display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.85}
.dsha-foot-btn:hover{opacity:1;background:rgba(128,128,128,.15)}
.dsha-foot-btn svg{width:15px;height:15px;flex:none}
.dsha-foot-count{font-size:10px;padding:0 5px;border-radius:7px;background:rgba(128,128,128,.35);line-height:14px}
`

function injectCss(): void {
  if (document.querySelector('style[data-plugin-css="dsh-plugin-atlas"]') !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin-css', 'dsh-plugin-atlas')
  style.textContent = CSS
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------

export const name = 'dsh-plugin-atlas'
export const inject = ['slots', 'locale', 'sessions']

/** Archive-box icon for the sidebar-foot trigger. */
function ArchiveIcon(): React.ReactElement {
  return createElement('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
    createElement('rect', { x: 2, y: 3, width: 12, height: 3, rx: 0.8 }),
    createElement('path', { d: 'M3.5 6.5v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-6' }),
    createElement('path', { d: 'M6.5 9h3' }))
}

export function apply(ctx: AtlasClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-atlas: dictionaries')
  injectCss()

  const t = ctx.locale.bind(NS)
  const api = makeApi()

  // Sidebar-foot trigger: opens the archive drawer.
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'atlas-archive', order: 50 },
      (props: { wide?: boolean }) => {
        const open = useDrawerOpen()
        return createElement('button', {
          type: 'button',
          className: 'dsha-foot-btn',
          title: t('drawer.title'),
          onClick: () => { setDrawerOpen(!open) },
        }, createElement(ArchiveIcon), props.wide === false ? null : createElement('span', null, t('drawer.title')))
      },
    ))

  // Archive drawer overlay.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'atlas-drawer', order: 200 },
      () => {
        const open = useDrawerOpen()
        if (!open) return null
        return createElement(ArchivePanel, { t, api, onClose: () => { setDrawerOpen(false) } })
      },
    ))

  // Conversation rail: a session-scoped child declared by one overlay entry.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'atlas-rail',
        order: 100,
        children: { 'atlas.rail': { kind: 'single', scope: 'session' } },
      },
      (props: { SessionProvider?: unknown; renderSlot?: (name: string, args: unknown) => unknown }) => {
        const provider = props.SessionProvider
        const renderSlot = props.renderSlot
        if (typeof provider !== 'function' || typeof renderSlot !== 'function') return null
        // The provider mounts the current session context and renders the
        // session-scoped child through the shell's own render bridge.
        type ProviderProps = { empty: () => unknown; children: () => unknown }
        return createElement(
          provider as unknown as React.FunctionComponent<ProviderProps>,
          { empty: () => null, children: () => renderSlot('atlas.rail', {}) },
        )
      },
    ))

  ctx.slots.inject('atlas.rail', () =>
    ctx.slots.register(
      {
        name: 'atlas.rail',
        inject: (sessionId: string) => ({
          jump: createJump(ctx.sessions, sessionId),
          loadAll: createLoadAll(ctx.sessions, sessionId),
          t,
        }),
      },
      (props: Parameters<typeof Rail>[0]) => createElement(Rail, props),
    ))
}
